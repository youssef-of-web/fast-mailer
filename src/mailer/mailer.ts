import { Socket } from 'net';
import { TLSSocket } from 'tls';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { MailerConfig, Metrics, MailOptions, SendResult, mimeTypes } from '../';

class FastMailer extends EventEmitter {

    private config: MailerConfig;
    private socket: Socket | TLSSocket | null;
    private connectionPool: Map<string, Socket | TLSSocket>;
    private metrics: Metrics;
    private logFilePath: string | undefined;
    private rateLimits: Map<string, {
        count: number,
        lastReset: number,
        banned: boolean,
        banExpiry: number,
        consecutiveFailures: number,
        lastFailure: number,
        rapidAttempts: number, // Track rapid sending attempts
        lastAttempt: number // Track timestamp of last attempt
    }>;

    constructor(config: MailerConfig) {
        super();
        // Determine if port requires secure connection
        const securePort = config.port === 465;
        
        this.config = {
            ...config,
            // Number of retry attempts for failed email sends
            retryAttempts: config.retryAttempts || 3,
            // Socket timeout in milliseconds
            timeout: config.timeout || 5000,
            // Whether to keep connections alive between sends
            keepAlive: config.keepAlive || false,
            // Maximum number of simultaneous connections
            poolSize: config.poolSize || 5,
            // Force secure true if using secure port
            secure: securePort ? true : config.secure,
            // Rate limiting configuration with more secure defaults
            rateLimiting: {
                perRecipient: true,
                burstLimit: 5, // Lower burst limit
                cooldownPeriod: 1000, // 1 second cooldown
                banDuration: 7200000, // 2 hours
                maxConsecutiveFailures: 3, // Max failures before temp ban
                failureCooldown: 300000, // 5 min failure cooldown
                maxRapidAttempts: 10, // Max attempts within rapid period
                rapidPeriod: 10000, // 10 second rapid period
                ...config.rateLimiting
            },
            // Logging configuration
            logging: {
                level: config.logging?.level || 'info',
                format: config.logging?.format || 'json',
                customFields: config.logging?.customFields || [],
                destination: config.logging?.destination
            }
        };

        if (!this.config.from) {
            throw new Error('From address is required in config');
        }

        // Log warning if secure port but secure not set
        if (securePort && !config.secure) {
            console.warn('Port 465 requires secure connection. Forcing secure: true');
        }

        // Setup logging
        if (this.config.logging?.destination) {
            try {
                this.logFilePath = path.isAbsolute(this.config.logging.destination) ?
                    this.config.logging.destination :
                    path.join(process.cwd(), this.config.logging.destination);

                const logDir = path.dirname(this.logFilePath);
                if (!fs.existsSync(logDir)) {
                    fs.mkdirSync(logDir, { recursive: true });
                }

                fs.appendFileSync(this.logFilePath, '');
            } catch (error) {
                this.logFilePath = undefined;
                console.warn('Failed to setup log file:', error);
            }
        }

        this.connectionPool = new Map();
        this.rateLimits = new Map();
        this.metrics = {
            emails_total: 0,
            emails_successful: 0,
            emails_failed: 0,
            failed_emails: [], // Add array to store failed emails
            email_send_duration_seconds: {
                sum: 0,
                count: 0,
                avg: 0,
                max: 0,
                min: Number.MAX_VALUE,
                buckets: {
                    '0.1': 0,
                    '0.5': 0,
                    '1': 0,
                    '2': 0,
                    '5': 0
                }
            },
            email_send_rate: 0,
            last_email_status: 'none',
            last_email_timestamp: Date.now(),
            active_connections: 0,
            connection_errors: 0,
            rate_limit_exceeded_total: 0,
            current_rate_limit_window: {
                count: 0,
                remaining: this.config.rateLimiting?.burstLimit || 5,
                reset_time: Date.now() + (this.config.rateLimiting?.cooldownPeriod || 1000)
            },
            errors_by_type: {
                connection: 0,
                authentication: 0,
                rate_limit: 0,
                validation: 0,
                timeout: 0,
                attachment: 0,
                command: 0,
                unknown: 0
            },
            consecutive_failures: 0,
            last_error_timestamp: null,
            banned_recipients_count: 0,
            total_retry_attempts: 0,
            successful_retries: 0,
            failure_details: {
                last_error: null,
                error_count_by_recipient: new Map(),
                most_common_errors: [],
                avg_failures_per_recipient: 0
            }
        };
        this.socket = null;
    }

    private validateEmail(email: string): boolean {
        // More strict email validation regex
        const emailRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]*[a-zA-Z0-9])?)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

        // Basic checks first
        if (!email || email.includes(' ') || email.includes('..') || email.startsWith('.') || email.endsWith('.') || email.includes('@@')) {
            return false;
        }

        return emailRegex.test(email);
    }

    private checkRateLimit(recipient: string): void {
        const now = Date.now();
        let recipientLimits = this.rateLimits.get(recipient);

        if (!recipientLimits) {
            recipientLimits = {
                count: 0,
                lastReset: now,
                banned: false,
                banExpiry: 0,
                consecutiveFailures: 0,
                lastFailure: 0,
                rapidAttempts: 0,
                lastAttempt: now
            };
            this.rateLimits.set(recipient, recipientLimits);
        }

        // Check rapid sending attempts
        const rapidPeriod = this.config.rateLimiting?.rapidPeriod || 10000; // 10 seconds
        if (now - recipientLimits.lastAttempt < rapidPeriod) {
            recipientLimits.rapidAttempts++;
            if (recipientLimits.rapidAttempts >= (this.config.rateLimiting?.maxRapidAttempts || 10)) {
                recipientLimits.banned = true;
                recipientLimits.banExpiry = now + (this.config.rateLimiting?.banDuration || 7200000);
                this.metrics.banned_recipients_count++;
                this.writeLog('debug', {
                    recipient,
                    event: 'banned',
                    reason: 'rapid_attempts',
                    attempts: recipientLimits.rapidAttempts,
                    period: rapidPeriod,
                    message: 'Too many rapid sending attempts'
                });
                throw {
                    code: 'ERATELIMIT',
                    message: 'Too many rapid sending attempts',
                    details: {
                        type: 'rate_limit_error',
                        context: {
                            recipient,
                            attempts: recipientLimits.rapidAttempts,
                            period: rapidPeriod
                        },
                        timestamp: new Date().toISOString()
                    }
                };
            }
        } else {
            recipientLimits.rapidAttempts = 1;
        }
        recipientLimits.lastAttempt = now;

        // Check if currently banned
        if (recipientLimits.banned) {
            if (now < recipientLimits.banExpiry) {
                this.metrics.last_email_status = 'failure';
                this.metrics.errors_by_type.rate_limit++;
                this.writeLog('debug', {
                    recipient,
                    event: 'banned',
                    banExpiry: new Date(recipientLimits.banExpiry).toISOString(),
                    consecutiveFailures: recipientLimits.consecutiveFailures,
                    message: 'Recipient is temporarily banned due to rate limit violations or consecutive failures'
                });
                throw {
                    code: 'ERATELIMIT',
                    message: 'Recipient is temporarily banned due to rate limit violations or consecutive failures',
                    details: {
                        type: 'rate_limit_error',
                        context: {
                            recipient,
                            banExpiry: new Date(recipientLimits.banExpiry).toISOString(),
                            consecutiveFailures: recipientLimits.consecutiveFailures
                        },
                        timestamp: new Date().toISOString()
                    }
                };
            } else {
                // Ban expired, reset all limits
                recipientLimits.banned = false;
                recipientLimits.count = 0;
                recipientLimits.lastReset = now;
                recipientLimits.consecutiveFailures = 0;
                recipientLimits.rapidAttempts = 0;
                this.metrics.banned_recipients_count--;
            }
        }

        // Check consecutive failures
        if (recipientLimits.consecutiveFailures >= (this.config.rateLimiting?.maxConsecutiveFailures ?? 3)) {
            const failureCooldown = this.config.rateLimiting?.failureCooldown ?? 300000;
            if (now - recipientLimits.lastFailure < failureCooldown) {
                recipientLimits.banned = true;
                recipientLimits.banExpiry = now + (this.config.rateLimiting?.banDuration ?? 7200000);
                this.metrics.last_email_status = 'failure';
                this.metrics.errors_by_type.rate_limit++;
                this.metrics.banned_recipients_count++;
                this.writeLog('debug', {
                    recipient,
                    event: 'banned',
                    consecutiveFailures: recipientLimits.consecutiveFailures,
                    failureCooldown,
                    message: 'Too many consecutive failures for recipient'
                });
                throw {
                    code: 'ERATELIMIT',
                    message: 'Too many consecutive failures for recipient',
                    details: {
                        type: 'rate_limit_error',
                        context: {
                            recipient,
                            consecutiveFailures: recipientLimits.consecutiveFailures,
                            failureCooldown
                        },
                        timestamp: new Date().toISOString()
                    }
                };
            } else {
                // Reset consecutive failures after cooldown
                recipientLimits.consecutiveFailures = 0;
            }
        }

        // Reset count if cooldown period has passed
        if (now - recipientLimits.lastReset > (this.config.rateLimiting?.cooldownPeriod ?? 1000)) {
            recipientLimits.count = 0;
            recipientLimits.lastReset = now;
        }

        // Check burst limit
        if (recipientLimits.count >= (this.config.rateLimiting?.burstLimit ?? 5)) {
            this.metrics.rate_limit_exceeded_total++;
            this.metrics.last_email_status = 'failure';
            this.metrics.errors_by_type.rate_limit++;
            this.writeLog('debug', {
                recipient,
                event: 'banned',
                burstLimit: this.config.rateLimiting?.burstLimit ?? 5,
                cooldownPeriod: this.config.rateLimiting?.cooldownPeriod ?? 1000,
                message: 'Rate limit exceeded for recipient'
            });

            throw {
                code: 'ERATELIMIT',
                message: 'Rate limit exceeded for recipient',
                details: {
                    type: 'rate_limit_error',
                    context: {
                        recipient,
                        burstLimit: this.config.rateLimiting?.burstLimit ?? 5,
                        cooldownPeriod: this.config.rateLimiting?.cooldownPeriod ?? 1000
                    },
                    timestamp: new Date().toISOString()
                }
            };
        }

        recipientLimits.count++;
    }

    private async createConnection(): Promise<Socket | TLSSocket> {
        return new Promise((resolve, reject) => {
            const socket = new Socket();

            socket.setTimeout(this.config.timeout!);

            socket.on('timeout', () => {
                socket.destroy();
                this.metrics.connection_errors++;
                this.metrics.last_email_status = 'failure';
                this.metrics.errors_by_type.timeout++;
                reject({
                    code: 'ETIMEDOUT',
                    message: 'Connection timeout',
                    details: {
                        type: 'connection_error',
                        context: {
                            host: this.config.host,
                            port: this.config.port,
                            timeout: this.config.timeout
                        },
                        timestamp: new Date().toISOString()
                    }
                });
            });

            socket.connect({
                host: this.config.host,
                port: this.config.port
            }, async () => {
                this.metrics.active_connections++;
                if (this.config.secure) {
                    const tlsSocket = new TLSSocket(socket, {
                        rejectUnauthorized: true,  // Enable certificate validation
                        minVersion: 'TLSv1.2',
                        maxVersion: 'TLSv1.3',
                        ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
                        honorCipherOrder: true
                    });
                    resolve(tlsSocket);
                } else {
                    resolve(socket);
                }
            });

            socket.on('error', (err: Error & { code?: string }) => {
                this.metrics.connection_errors++;
                this.metrics.last_email_status = 'failure';
                this.metrics.errors_by_type.connection++;
                reject({
                    code: err.code || 'ECONNECTION',
                    message: err.message,
                    details: {
                        type: 'connection_error',
                        context: {
                            host: this.config.host,
                            port: this.config.port,
                            originalError: err
                        },
                        timestamp: new Date().toISOString()
                    }
                });
            });
        });
    }

    private async sendCommand(socket: Socket | TLSSocket, command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const responseHandler = (data: Buffer) => {
                const response = data.toString();
                socket.removeListener('data', responseHandler);
                resolve(response);
            };

            socket.on('data', responseHandler);
            socket.write(command + '\r\n', (err) => {
                if (err) {
                    socket.removeListener('data', responseHandler);
                    this.metrics.last_email_status = 'failure';
                    this.metrics.errors_by_type.command++;
                    reject({
                        code: 'ECOMMAND',
                        message: 'Failed to send command',
                        details: {
                            type: 'command_error',
                            context: {
                                command: command.substring(0, 20) + '...',
                                error: err
                            },
                            timestamp: new Date().toISOString()
                        }
                    });
                }
            });
        });
    }

    private generateBoundary(): string {
        return '----' + crypto.randomBytes(16).toString('hex');
    }

    private sanitizeHeader(value: string): string {
        // Remove newlines and other potentially dangerous characters
        return value.replace(/[\r\n\t\v\f]/g, '');
    }

    
    private sanitizePath(filePath: string): string {
        try {
            // Normalize the path to handle different path formats
            const normalizedPath = path.normalize(filePath);
            
            // Get the absolute path, using process.cwd() as base if path is relative
            const absolutePath = path.isAbsolute(normalizedPath)
                ? normalizedPath
                : path.join(process.cwd(), normalizedPath);
    
            // For debugging
            if(this.config.logging?.level === "debug"){
                console.log('Path details:', {
                    original: filePath,
                    normalized: normalizedPath,
                    absolute: absolutePath,
                    exists: fs.existsSync(absolutePath),
                    cwd: process.cwd()
                });
            }
    
            // Verify the file exists
            if (!fs.existsSync(absolutePath)) {
                throw new Error(`File does not exist: ${filePath}`);
            }
    
            // Verify file is readable
            try {
                fs.accessSync(absolutePath, fs.constants.R_OK);
            } catch (err:any) {
                throw new Error(`File is not readable: ${filePath}`);
            }
    
            return absolutePath;
        } catch (err:any) {
            throw new Error(`Path validation failed: ${err?.message}`);
        }
    }

    private buildMimeMessage(options: MailOptions, boundary: string): string {
        let message = '';

        // Headers
        message += 'MIME-Version: 1.0\r\n';
        message += `From: ${this.sanitizeHeader(this.config.from)}\r\n`;
        message += `To: ${this.sanitizeHeader(Array.isArray(options.to) ? options.to.join(', ') : options.to)}\r\n`;
        if (options.cc) {
            message += `Cc: ${Array.isArray(options.cc) ? options.cc.join(', ') : options.cc}\r\n`;
        }
        message += `Subject: ${this.sanitizeHeader(options.subject)}\r\n`;
        message += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

        // Text/HTML Content
        if (options.text) {
            message += `--${boundary}\r\n`;
            message += 'Content-Type: text/plain; charset=utf-8\r\n\r\n';
            message += options.text + '\r\n\r\n';
        }

        if (options.html) {
            message += `--${boundary}\r\n`;
            message += 'Content-Type: text/html; charset=utf-8\r\n\r\n';
            message += options.html + '\r\n\r\n';
        }

        // Attachments
        if (options.attachments) {
            for (const attachment of options.attachments) {
                let content: Buffer;
                let filename: string;

                if (attachment.path) {
                    try {
                        const filePath = this.sanitizePath(attachment.path);
                        content = fs.readFileSync(filePath);


                        console.log("filePath", filePath)
                        

                        if (!attachment.filename) {
                            filename = path.basename(filePath);
                        } else {
                            const fileExt = path.extname(filePath);
                            filename = path.extname(attachment.filename) ? attachment.filename : attachment.filename + fileExt;
                        }
                    } catch (err) {
                        this.metrics.last_email_status = 'failure';
                        this.metrics.errors_by_type.attachment++;
                        throw {
                            code: 'EATTACHMENT',
                            message: 'Failed to read attachment file',
                            details: {
                                type: 'attachment_error',
                                context: {
                                    path: attachment.path,
                                    error: err
                                },
                                timestamp: new Date().toISOString()
                            }
                        };
                    }
                } else if (attachment.content) {
                    content = Buffer.isBuffer(attachment.content) ?
                        attachment.content :
                        Buffer.from(attachment.content);
                    filename = attachment.filename || 'attachment';
                } else {
                    continue;
                }

                const contentType = attachment.contentType || this.detectMimeType(filename);

                message += `--${boundary}\r\n`;
                message += `Content-Type: ${contentType}\r\n`;
                message += `Content-Disposition: attachment; filename="${filename}"\r\n`;
                message += `Content-Transfer-Encoding: ${attachment.encoding || 'base64'}\r\n\r\n`;
                message += content.toString('base64') + '\r\n\r\n';
            }
        }

        message += `--${boundary}--\r\n.`;
        return message;
    }

    private detectMimeType(filename: string): string {
        const ext = path.extname(filename).toLowerCase();
        const mimeTypesList = mimeTypes;

        return mimeTypesList[ext] || 'application/octet-stream';
    }

    private shouldLog(level: string): boolean {
        const configLevel = this.config.logging?.level || 'info';
        
        // If config level is debug, log everything
        if (configLevel === 'debug') {
            return true;
        }
        
        // For other levels, only log matching or higher priority events
        switch (configLevel) {
            case 'info':
                return level === 'info'; // Only log successful events
            case 'warn':
                return level === 'warn'; // Only log warnings
            case 'error':
                return level === 'error'; // Only log errors
            default:
                return false;
        }
    }

    private maskSensitiveData(data: any): any {
        if (!data) return data;
        
        const sensitiveFields = ['password', 'auth', 'token', 'key'];
        const masked = { ...data };
        
        for (const field of sensitiveFields) {
            if (masked[field]) {
                masked[field] = '********';
            }
        }
        
        return masked;
    }

    private writeLog(level: string, data: any): void {
        // First check if we should log this message
        if (!this.logFilePath || !this.shouldLog(level)) {
            return;
        }

        try {
            // Mask sensitive data
            const maskedData = this.maskSensitiveData(data);

            const logEntry = {
                timestamp: new Date().toISOString(),
                level,
                ...maskedData
            };

            // Add custom fields if configured
            if (this.config.logging?.customFields) {
                for (const field of this.config.logging.customFields) {
                    if (data[field]) {
                        logEntry[field] = data[field];
                    }
                }
            }

            // Format the log entry
            let formattedLog: string;
            if (this.config.logging?.format === 'text') {
                formattedLog = `[${logEntry.timestamp}] ${level.toUpperCase()}: ${JSON.stringify(maskedData)}\n`;
            } else {
                formattedLog = JSON.stringify(logEntry) + '\n';
            }

            // Write to file
            fs.appendFileSync(this.logFilePath, formattedLog);
        } catch (error) {
            console.warn('Failed to write log:', error);
        }
    }

    public async sendMail(options: MailOptions): Promise<SendResult> {
        // Debug level logging
        this.writeLog('debug', {
            event: 'mail_attempt',
            recipients: options.to,
            subject: options.subject,
            timestamp: new Date().toISOString()
        });

        // First verify connection before proceeding
        if (!await this.verifyConnection()) {
            this.metrics.last_email_status = 'failure';
            this.metrics.errors_by_type.connection++;

            throw {
                code: 'ECONNECTION',
                message: 'SMTP connection failed, cannot send email',
                details: {
                    type: 'connection_error',
                    context: {
                        host: this.config.host,
                        port: this.config.port
                    },
                    timestamp: new Date().toISOString()
                }
            };
        }

        const recipients = [
            ...(Array.isArray(options.to) ? options.to : [options.to]),
            ...(options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : []),
            ...(options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : [])
        ];

        // Validate email format for all recipients
        for (const recipient of recipients) {
            if (!this.validateEmail(recipient)) {
                this.metrics.last_email_status = 'failure';
                this.metrics.errors_by_type.validation++;
                throw {
                    code: 'EINVALIDEMAIL',
                    message: `Invalid email format: ${recipient}`,
                    details: {
                        type: 'validation_error',
                        context: {
                            recipient
                        },
                        timestamp: new Date().toISOString()
                    }
                };
            }
        }

        // Check rate limits for each recipient if enabled
        if (this.config.rateLimiting?.perRecipient) {
            for (const recipient of recipients) {
                this.checkRateLimit(recipient);
            }
        }

        const startTime = Date.now();
        let socket: Socket | TLSSocket | undefined;
        let currentCommand = '';

        try {
            socket = await this.createConnection();

            currentCommand = 'EHLO';
            await this.sendCommand(socket, `EHLO ${this.config.host}`);

            if (!this.config.secure) {
                currentCommand = 'STARTTLS';
                await this.sendCommand(socket, 'STARTTLS');
                const tlsSocket = new TLSSocket(socket, {
                    rejectUnauthorized: true,  // Enable certificate validation
                    minVersion: 'TLSv1.2',
                    maxVersion: 'TLSv1.3',
                    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
                    honorCipherOrder: true
                });
            }

            currentCommand = 'AUTH';
            await this.sendCommand(socket, `AUTH LOGIN`);
            await this.sendCommand(socket, Buffer.from(this.config.auth.user).toString('base64'));
            await this.sendCommand(socket, Buffer.from(this.config.auth.pass).toString('base64'));

            currentCommand = 'MAIL FROM';
            await this.sendCommand(socket, `MAIL FROM:<${this.config.from}>`);

            currentCommand = 'RCPT TO';
            for (const recipient of recipients) {
                await this.sendCommand(socket, `RCPT TO:<${recipient}>`);
            }

            currentCommand = 'DATA';
            await this.sendCommand(socket, 'DATA');

            const boundary = this.generateBoundary();
            const mimeMessage = this.buildMimeMessage(options, boundary);
            await this.sendCommand(socket, mimeMessage);

            const messageId = crypto.randomBytes(16).toString('hex');
            const sendTime = Date.now() - startTime;

            // Reset consecutive failures on success
            if (this.config.rateLimiting?.perRecipient) {
                for (const recipient of recipients) {
                    const limits = this.rateLimits.get(recipient);
                    if (limits) {
                        limits.consecutiveFailures = 0;
                    }
                }
            }

            this.updateMetrics(true, sendTime);

            // Info level logging for success
            this.writeLog('info', {
                success: true,
                event: 'mail_success',
                messageId,
                recipients: options.to,
                subject: options.subject,
                sendTime
            });

            return {
                success: true,
                messageId,
                timestamp: new Date(),
                recipients: recipients.join(', '),
            };

        } catch (error: any) {
            // Store failed email details in metrics with enhanced tracking
            const failureDetails = {
                timestamp: new Date(),
                recipient: recipients.join(', '),
                subject: options.subject,
                error: {
                    code: error.code,
                    message: error.message,
                    details: error.details
                },
                command: currentCommand,
                attempt: 1
            };

            this.metrics.failed_emails.push(failureDetails);
            this.metrics.failure_details.last_error = failureDetails;

            // Update per-recipient error counts
            for (const recipient of recipients) {
                const currentCount = this.metrics.failure_details.error_count_by_recipient.get(recipient) || 0;
                this.metrics.failure_details.error_count_by_recipient.set(recipient, currentCount + 1);
            }

            // Calculate average failures per recipient
            const totalRecipients = this.metrics.failure_details.error_count_by_recipient.size;
            const totalFailures = Array.from(this.metrics.failure_details.error_count_by_recipient.values())
                .reduce((sum, count) => sum + count, 0);
            this.metrics.failure_details.avg_failures_per_recipient = totalRecipients ? totalFailures / totalRecipients : 0;

            // Update consecutive failures
            if (this.config.rateLimiting?.perRecipient) {
                for (const recipient of recipients) {
                    const limits = this.rateLimits.get(recipient);
                    if (limits) {
                        limits.consecutiveFailures++;
                        limits.lastFailure = Date.now();
                    }
                }
            }

            const sendTime = Date.now() - startTime;
            this.updateMetrics(false, sendTime);
            this.metrics.last_email_status = 'failure';
            this.metrics.consecutive_failures++;
            this.metrics.last_error_timestamp = Date.now();

            // Update error type metrics
            if (error.details?.type) {
                switch (error.details.type) {
                    case 'connection_error':
                        this.metrics.errors_by_type.connection++;
                        break;
                    case 'authentication_error':
                        this.metrics.errors_by_type.authentication++;
                        break;
                    case 'rate_limit_error':
                        this.metrics.errors_by_type.rate_limit++;
                        break;
                    case 'validation_error':
                        this.metrics.errors_by_type.validation++;
                        break;
                    case 'timeout_error':
                        this.metrics.errors_by_type.timeout++;
                        break;
                    case 'attachment_error':
                        this.metrics.errors_by_type.attachment++;
                        break;
                    case 'command_error':
                        this.metrics.errors_by_type.command++;
                        break;
                    default:
                        this.metrics.errors_by_type.unknown++;
                }
            } else {
                this.metrics.errors_by_type.unknown++;
            }

            const errorDetails = {
                code: error.code || 'EUNKNOWN',
                message: error.message || 'An unknown error occurred',
                details: {
                    type: error.details?.type || 'smtp_error',
                    context: {
                        ...error.details?.context,
                        lastCommand: currentCommand,
                        recipients,
                        subject: options.subject,
                        attemptNumber: 1,
                        socketState: socket ? 'connected' : 'disconnected'
                    },
                    timestamp: new Date().toISOString()
                }
            };

            // Error level logging
            this.writeLog('error', {
                success: false,
                event: 'mail_failure',
                error: errorDetails,
                recipients: options.to,
                subject: options.subject,
                sendTime
            });

            throw errorDetails;
        } finally {
            if (socket && !this.config.keepAlive) {
                socket.end();
                this.metrics.active_connections--;
            }
        }
    }

    private updateMetrics(success: boolean, sendTime: number): void {
        // Update counters
        this.metrics.emails_total++;
        if (success) {
            this.metrics.emails_successful++;
            this.metrics.last_email_status = 'success';
            this.metrics.consecutive_failures = 0;
        } else {
            this.metrics.emails_failed++;
            this.metrics.last_email_status = 'failure';
        }

        // Update timing metrics
        const sendTimeSeconds = sendTime / 1000;
        this.metrics.email_send_duration_seconds.count++;
        this.metrics.email_send_duration_seconds.sum += sendTimeSeconds;
        this.metrics.email_send_duration_seconds.avg =
            this.metrics.email_send_duration_seconds.sum / this.metrics.email_send_duration_seconds.count;
        this.metrics.email_send_duration_seconds.max =
            Math.max(this.metrics.email_send_duration_seconds.max, sendTimeSeconds);
        this.metrics.email_send_duration_seconds.min =
            Math.min(this.metrics.email_send_duration_seconds.min, sendTimeSeconds);

        // Update histogram buckets
        Object.keys(this.metrics.email_send_duration_seconds.buckets).forEach(bucket => {
            if (sendTimeSeconds <= parseFloat(bucket)) {
                this.metrics.email_send_duration_seconds.buckets[bucket as keyof typeof this.metrics.email_send_duration_seconds.buckets]++;
            }
        });

        // Update rate metrics
        const now = Date.now();
        const timeWindow = 60000; // 1 minute
        this.metrics.email_send_rate = this.metrics.emails_total / ((now - this.metrics.last_email_timestamp) / timeWindow);
        this.metrics.last_email_timestamp = now;

    }

    public getMetrics(): Metrics {
        return { ...this.metrics };
    }

    public async verifyConnection(): Promise<boolean> {
        try {
            const socket = await this.createConnection();
            socket.end();
            return true;
        } catch {
            this.metrics.last_email_status = 'failure';
            this.metrics.errors_by_type.connection++;
            return false;
        }
    }
}

export default FastMailer;
