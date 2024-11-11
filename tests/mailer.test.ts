import { FastMailer } from '../src';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { Socket } from 'net';
import { TLSSocket } from 'tls';
import { EventEmitter } from 'events';

dotenv.config({path: path.join(__dirname, '../.env.test')});

describe('FastMailer', () => {
    let mailer: FastMailer;

    beforeEach(() => {
        mailer = new FastMailer({
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '465'),
            from: process.env.FROM || '',
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            },
            secure: true,
            rateLimiting: {
                perRecipient: true,
                burstLimit: 5,
                cooldownPeriod: 1000,
                banDuration: 7200000,
                maxConsecutiveFailures: 3,
                failureCooldown: 300000
            },
            logging: {
                level: 'debug',
                format: 'json',
                destination: "./mailer.log"
            }
        });
    });

    describe('sendMail', () => {
        it('should send an email successfully', async () => {
            const result = await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'Test Email',
                text: 'This is a test email'
            });

            expect(result.success).toBe(true);
            expect(result.messageId).toBeDefined();
            expect(result.timestamp).toBeInstanceOf(Date);
            expect(result.recipients).toBeDefined();
        }, 15000); // Increased timeout to 15 seconds

        it('should handle multiple recipients', async () => {
            const result = await mailer.sendMail({
                to: [process.env.TO || '', process.env.TO_2 || ''],
                subject: 'Test Email',
                text: 'This is a test email'
            });

            expect(result.success).toBe(true);
            expect(result.recipients).toContain(process.env.TO);
            expect(result.recipients).toContain(process.env.TO_2);
        }, 15000);

        it('should send HTML content', async () => {
            const result = await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'HTML Test',
                html: '<h1>Hello</h1><p>This is HTML content</p>'
            });

            expect(result.success).toBe(true);
        }, 15000);

        it('should handle CC and BCC recipients', async () => {
            const result = await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'CC/BCC Test',
                text: 'Testing CC and BCC',
                cc: process.env.TO_2 || '',
                bcc: process.env.EMAIL_USER || ''
            });

            expect(result.success).toBe(true);
            expect(result.recipients).toContain(process.env.TO);
            expect(result.recipients).toContain(process.env.TO_2);
            expect(result.recipients).toContain(process.env.EMAIL_USER);
        }, 15000);

        it('should handle attachments', async () => {
            const result = await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'Attachment Test',
                text: 'Testing attachments',
                attachments: [{
                    filename: 'test.txt',
                    content: 'Hello World'
                }]
            });

            expect(result.success).toBe(true);
        }, 15000);

        it('should handle file path attachments', async () => {
            // Create a temporary test file
            fs.writeFileSync('test.txt', 'Test content');

            const result = await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'File Attachment Test',
                text: 'Testing file attachments',
                attachments: [{
                    path: './test.txt'
                }]
            });

            // Clean up
            fs.unlinkSync('test.txt');

            expect(result.success).toBe(true);
        }, 15000);

        it('should handle custom headers', async () => {
            const result = await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'Headers Test',
                text: 'Testing custom headers',
                headers: {
                    'X-Custom-Header': 'test-value'
                }
            });

            expect(result.success).toBe(true);
        }, 15000);
    });

    describe('verifyConnection', () => {
        it('should verify connection successfully', async () => {
            const isConnected = await mailer.verifyConnection();
            expect(isConnected).toBe(true);
        }, 15000);

        it('should handle failed connections', async () => {
            const badMailer = new FastMailer({
                host: 'invalid.host',
                port: 465,
                from: 'test@test.com',
                auth: {
                    user: 'test',
                    pass: 'test'
                },
                logging: {
                    level: 'debug',
                    format: 'json'
                }
            });

            const isConnected = await badMailer.verifyConnection();
            expect(isConnected).toBe(false);
        }, 15000);
    });

    describe('getMetrics', () => {
        it('should track email metrics', async () => {
            await mailer.sendMail({
                to: process.env.TO || '',
                subject: 'Metrics Test',
                text: 'Testing metrics',
            });

            const metrics = mailer.getMetrics();

            expect(metrics.emails_total).toBe(1);
            expect(metrics.emails_successful).toBe(1);
            expect(metrics.emails_failed).toBe(0);
            expect(metrics.email_send_duration_seconds.avg).toBeGreaterThan(0);
            expect(metrics.email_send_duration_seconds.min).toBe(metrics.email_send_duration_seconds.max);
            expect(metrics.email_send_duration_seconds.buckets['0.1']).toBeGreaterThanOrEqual(0);
            expect(metrics.email_send_duration_seconds.buckets['5']).toBeGreaterThanOrEqual(0);
            expect(metrics.email_send_rate).toBeGreaterThanOrEqual(0);
            expect(metrics.last_email_timestamp).toBeDefined();
            expect(metrics.last_email_status).toBe('success');
            expect(metrics.active_connections).toBeDefined();
            expect(metrics.connection_errors).toBeDefined();
            expect(metrics.rate_limit_exceeded_total).toBeDefined();
            expect(metrics.current_rate_limit_window).toBeDefined();
            expect(metrics.errors_by_type).toBeDefined();
            expect(metrics.consecutive_failures).toBeDefined();
            expect(metrics.banned_recipients_count).toBeDefined();
            expect(metrics.total_retry_attempts).toBeDefined();
            expect(metrics.successful_retries).toBeDefined();
        }, 15000);

        it('should track connection errors', async () => {
            const badMailer = new FastMailer({
                host: 'invalid.host',
                port: 465,
                from: 'test@test.com',
                auth: {
                    user: 'test',
                    pass: 'test'
                },
                logging: {
                    level: 'debug',
                    format: 'json'
                }
            });

            try {
                await badMailer.sendMail({
                    to: 'test@test.com',
                    subject: 'Failed Test',
                    text: 'Testing failed metrics'
                });
                expect(false).toBe(true); // Force test to fail if no error thrown
            } catch (error: any) {
                expect(error.code).toBe('ECONNECTION');
                expect(error.message).toBe('SMTP connection failed, cannot send email');
                expect(error.details.type).toBe('connection_error');
                expect(error.details.context.host).toBe('invalid.host');
                expect(error.details.context.port).toBe(465);
                expect(error.details.timestamp).toBeDefined();
            }

            const metrics = badMailer.getMetrics();
            console.log("Metrics: ", metrics);
            expect(metrics.emails_total).toBe(0);
            expect(metrics.emails_failed).toBe(0);
            expect(metrics.emails_successful).toBe(0);
            expect(metrics.last_email_status).toBe('failure');
            expect(metrics.connection_errors).toBe(1);
            expect(metrics.errors_by_type.connection).toBeGreaterThan(1);
        }, 15000);

        it('should track invalid sender errors', async () => {
            const mailer = new FastMailer({
                host: process.env.SMTP_HOST || '',
                port: parseInt(process.env.SMTP_PORT || '465'),
                from: 'invalid',
                auth: {
                    user: process.env.EMAIL_USER || '',
                    pass: process.env.EMAIL_PASS || ''
                },
            });

            try {
                await mailer.sendMail({
                    to: 'invalid-mail',
                    subject: 'Failed Test', 
                    text: 'Testing failed metrics'
                });
                expect(false).toBe(true); // Force test to fail if no error thrown
            } catch (error: any) {
                expect(error.code).toBe('EINVALIDEMAIL');
                expect(error.details.type).toBe('validation_error');
            }

            const metrics = mailer.getMetrics();
            console.log("Metrics 2: ", metrics);
            expect(metrics.emails_total).toBe(0);
            expect(metrics.emails_failed).toBe(0); 
            expect(metrics.active_connections).toBe(1);
            expect(metrics.email_send_duration_seconds.count).toBe(0);
            expect(metrics.current_rate_limit_window.remaining).toBeDefined();
            expect(metrics.current_rate_limit_window.reset_time).toBeGreaterThan(Date.now());
            expect(metrics.consecutive_failures).toBe(0);
        }, 15000);
    });

    it('should reject invalid email addresses', async () => {
        const invalidEmail = "notanemail"

        
            try {
                await mailer.sendMail({
                    to: invalidEmail,
                    subject: 'Test Email',
                    text: 'Test content'
                });
                expect(false).toBe(true); // Force test to fail if no error thrown
            } catch (error: any) {
                expect(error.code).toBe('EINVALIDEMAIL');
                expect(error.message).toBe(`Invalid email format: ${invalidEmail}`);
                expect(error.details).toMatchObject({
                    type: 'validation_error',
                    context: { recipient: invalidEmail },
                    timestamp: expect.any(String)
                });
        }

        const metrics = mailer.getMetrics();
        console.log("Metrics: ", metrics);
        expect(metrics.emails_failed).toBe(0);
    /*     expect(metrics.errors_by_type.validation).toBe(invalidEmails.length); */
        expect(metrics.consecutive_failures).toBe(0);
    }, 15000);

    describe('Configuration', () => {
        it('should use default values for optional config', () => {
            const mailer = new FastMailer({
                host: process.env.SMTP_HOST || '',
                port: parseInt(process.env.SMTP_PORT || '465'),
                secure: true,
                auth: {
                    user: process.env.EMAIL_USER || '',
                    pass: process.env.EMAIL_PASS || ''
                },
                from: process.env.FROM || ''
            });

            // @ts-ignore - Accessing private config for testing
            const config = mailer['config'];

            expect(config.retryAttempts).toBe(3);
            expect(config.timeout).toBe(5000);
            expect(config.keepAlive).toBe(false);
            expect(config.poolSize).toBe(5);
            expect(config.rateLimiting?.burstLimit).toBe(5);
            expect(config.rateLimiting?.cooldownPeriod).toBe(1000);
            expect(config.rateLimiting?.banDuration).toBe(7200000);
            expect(config.rateLimiting?.maxConsecutiveFailures).toBe(3);
            expect(config.rateLimiting?.failureCooldown).toBe(300000);
        }, 15000);

        it('should override default values with provided config', () => {
            const mailer = new FastMailer({
                host: process.env.SMTP_HOST || '',
                port: parseInt(process.env.SMTP_PORT || '465'),
                secure: true,
                auth: {
                    user: process.env.EMAIL_USER || '',
                    pass: process.env.EMAIL_PASS || ''
                },
                from: process.env.FROM || '',
                retryAttempts: 5,
                timeout: 10000,
                keepAlive: true,
                poolSize: 10,
                rateLimiting: {
                    perRecipient: true,
                    burstLimit: 10,
                    cooldownPeriod: 2000,
                    banDuration: 3600000,
                    maxConsecutiveFailures: 5,
                    failureCooldown: 600000
                }
            });

            // @ts-ignore - Accessing private config for testing
            const config = mailer['config'];

            expect(config.retryAttempts).toBe(5);
            expect(config.timeout).toBe(10000);
            expect(config.keepAlive).toBe(true);
            expect(config.poolSize).toBe(10);
            expect(config.rateLimiting?.burstLimit).toBe(10);
            expect(config.rateLimiting?.cooldownPeriod).toBe(2000);
            expect(config.rateLimiting?.banDuration).toBe(3600000);
            expect(config.rateLimiting?.maxConsecutiveFailures).toBe(5);
            expect(config.rateLimiting?.failureCooldown).toBe(600000);
        }, 15000);

        it('should throw error if from address is missing', () => {
            expect(() => new FastMailer({
                host: process.env.SMTP_HOST || '',
                port: parseInt(process.env.SMTP_PORT || '465'),
                auth: {
                    user: 'test',
                    pass: 'test'
                }
            } as any)).toThrow('From address is required in config');
        }, 15000);
    });
});
