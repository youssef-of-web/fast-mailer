export interface MailerConfig {
    host: string;
    port: number;
    secure?: boolean;
    auth: {
        user: string;
        pass: string;
    };
    /** Email address to send mail from */
    from: string;
    /** Number of times to retry failed email sends (default: 3) */
    retryAttempts?: number;
    /** Socket timeout in milliseconds (default: 5000) */
    timeout?: number;
    /** Whether to keep connection alive between sends (default: false) */
    keepAlive?: boolean;
    /** Maximum number of simultaneous connections to maintain (default: 5) */
    poolSize?: number;
    /** Rate limiting configuration */
    rateLimiting?: {
        perRecipient?: boolean;
        burstLimit?: number;
        cooldownPeriod?: number;
        banDuration?: number;
        maxConsecutiveFailures?: number;
        failureCooldown?: number;
        maxRapidAttempts?: number;
        rapidPeriod?: number;
    };
    logging?: {
        level?: 'debug' | 'info' | 'warn' | 'error';
        format?: 'json' | 'text';
        customFields?: string[];
        destination?: string;
    };
}

export interface Attachment {
    filename?: string; // Optional since we may extract from path
    path?: string; // File path (absolute or relative)
    content?: string | Buffer;
    contentType?: string;
    encoding?: string;
}

export interface MailOptions {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: Attachment[];
    cc?: string | string[];
    bcc?: string | string[];
    priority?: 'high' | 'normal' | 'low';
    headers?: { [key: string]: string };
}

export interface SendResult {
    success: boolean;
    messageId?: string;
    error?: {
        code: string;
        message: string;
        details?: {
            type: 'connection_error' | 'authentication_error' | 'rate_limit_error' | 'validation_error' | 'timeout_error' | 'attachment_error' | 'command_error' | 'unknown_error';
            context: any;
            timestamp: string;
            attemptNumber?: number;
            socketState?: string;
            lastCommand?: string;
            serverResponse?: string;
        };
    };
    recipients: string;
    timestamp: Date;
}

export interface Metrics {
    // Counter metrics
    emails_total: number;
    emails_successful: number;
    emails_failed: number;
    failed_emails: {
        timestamp: Date;
        recipient: string;
        subject: string;
        error: {
            code: string;
            message: string;
            details: any;
        };
    }[];
    // Timing metrics
    email_send_duration_seconds: {
        sum: number;
        count: number;
        avg: number;
        max: number;
        min: number;
        buckets: {
            '0.1': number;
            '0.5': number;
            '1': number;
            '2': number;
            '5': number;
        };
    };
    
    // Rate metrics
    email_send_rate: number; // Emails per second
    
    // Status metrics
    last_email_status: 'success' | 'failure' | 'none';
    last_email_timestamp: number;
    
    // Connection metrics
    active_connections: number;
    connection_errors: number;
    
    // Rate limiting metrics
    rate_limit_exceeded_total: number;
    current_rate_limit_window: {
        count: number;
        remaining: number;
        reset_time: number;
    };
    
    // Error metrics
    errors_by_type: {
        connection: number;
        authentication: number;
        rate_limit: number;
        validation: number;
        timeout: number;
        attachment: number;
        command: number;
        unknown: number;
    };
    consecutive_failures: number;
    last_error_timestamp: number | null;
    banned_recipients_count: number;
    total_retry_attempts: number;
    successful_retries: number;
    failure_details: {
        last_error: {
            timestamp: Date;
            recipient: string;
            subject: string;
            error: {
                code: string;
                message: string;
                details: any;
            };
            command: string;
            attempt: number;
        } | null;
        error_count_by_recipient: Map<string, number>;
        most_common_errors: Array<{
            type: string;
            count: number;
        }>;
        avg_failures_per_recipient: number;
    };

}