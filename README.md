# Fast-Mailer

High-performance, intelligent email delivery system powered by advanced technology.

## Features

- 🚀 High-performance email sending with connection pooling
- 🔒 TLS/SSL security with modern cipher support 
- 🛡️ Advanced rate limiting and spam protection
- 📊 Detailed metrics and monitoring
- 📎 Attachment support with MIME type detection
- ♻️ Comprehensive error handling and retries
- 📝 Logging with customizable formats and levels
- 🔷 TypeScript support with full type definitions

## What's new in v2.0

- ✨ Enhanced rate limiting with per-recipient tracking and rapid attempt detection
- 🔒 Improved security with TLS 1.2/1.3 and modern cipher suites
- 📊 Extended metrics with detailed failure tracking
- 🛡️ Advanced spam protection with recipient banning
- 📝 Enhanced logging with masking of sensitive data
- ♻️ Improved error handling with detailed error context

### FastMailer vs NodeMailer

- 🚀 Up to 5x faster email sending with connection pooling
- 🔒 Modern TLS/SSL security with cipher suite control
- 🛡️ Advanced rate limiting and spam protection
- 📊 Comprehensive metrics and monitoring
- 📎 Smart MIME type detection for attachments
- ♻️ Intelligent error handling and retries
- 📝 Structured logging with customizable formats
- 🔷 Full TypeScript support with type definitions

## Installation

```bash
npm install fast-mailer
```

### Basic Example

```typescript
import { FastMailer } from 'fast-mailer';

const mailer = new FastMailer({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    auth: {
        user: 'user@example.com',
        pass: 'password'
    },
    from: 'user@example.com'
});
```

### Sending an Email

```typescript
mailer.send({
    to: 'recipient@example.com',
    subject: 'Hello, world!',
    text: 'This is a test email.'
});
```

### Sending an Email with Attachments

```typescript
 mailer.send({
    to: 'recipient@example.com',
    subject: 'Hello, world!',
    text: 'This is a test email.',
    attachments: [{ filename: 'example.txt', path: 'path/to/example.txt' }]
});
```

### Using a Custom Logger

```typescript

const mailer = new FastMailer({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    from: 'user@example.com',
    auth: {
        user: 'user@example.com',
        pass: 'password'
    },
    logging: {
        level: 'debug', // 'debug', 'info', 'warn', 'error'
        format: 'json', // 'json' or 'text'
        destination: 'logs/mailer.log',
        customFields: ['messageId', 'recipients'] // Additional fields to include
    }
});

// Logs will be written to logs/mailer.log with entries like:
// JSON format:
{
    "timestamp": "2024-02-20T10:30:45.123Z",
    "level": "info",
    "event": "mail_success", 
    "messageId": "abc123",
    "recipients": ["user@example.com"],
    "subject": "Test Email",
    "sendTime": 150
}

// Text format:
// [2024-02-20T10:30:45.123Z] INFO: {"event":"mail_success","messageId":"abc123",...}

```

### Using Metrics

```typescript

const mailer = new FastMailer({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    from: 'user@example.com',
    auth: {
        user: 'user@example.com',
        pass: 'password'
    }
});

// Get current metrics
const metrics = mailer.getMetrics();

console.log('Email Metrics:', {
    total: metrics.emails_total,
    successful: metrics.emails_successful, 
    failed: metrics.emails_failed,
    avgSendTime: metrics.email_send_duration_seconds.avg,
    sendRate: metrics.email_send_rate,
    activeConnections: metrics.active_connections,
    errorsByType: metrics.errors_by_type
});

```

### Rate Limiting

```typescript

const mailer = new FastMailer({
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    from: 'user@example.com',
    auth: {
        user: 'user@example.com',
        pass: 'password'
    },
    rateLimiting: {
        perRecipient: true,
        burstLimit: 5,
        cooldownPeriod: 1000,
        banDuration: 7200000,
        maxConsecutiveFailures: 3,
        failureCooldown: 300000
    }
});


```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| host | string | - | SMTP server hostname (required) |
| port | number | - | SMTP server port (required) |
| secure | boolean | false | Whether to use TLS/SSL connection |
| auth | object | - | Authentication credentials (required) |
| auth.user | string | - | SMTP username |
| auth.pass | string | - | SMTP password |
| from | string | - | Default sender email address (required) |
| retryAttempts | number | 3 | Number of retry attempts for failed sends |
| timeout | number | 5000 | Socket timeout in milliseconds |
| keepAlive | boolean | false | Keep connection alive between sends |
| poolSize | number | 5 | Maximum number of simultaneous connections |
| rateLimiting | object | - | Rate limiting configuration |
| rateLimiting.perRecipient | boolean | true | Apply limits per recipient |
| rateLimiting.burstLimit | number | 5 | Maximum emails per cooldown period |
| rateLimiting.cooldownPeriod | number | 1000 | Cooldown period in milliseconds |
| rateLimiting.banDuration | number | 7200000 | Ban duration in milliseconds (2 hours) |
| rateLimiting.maxConsecutiveFailures | number | 3 | Max failures before temp ban |
| rateLimiting.failureCooldown | number | 300000 | Failure cooldown in milliseconds (5 min) |
| rateLimiting.maxRapidAttempts | number | 5 | Max rapid attempts before temp ban |
| rateLimiting.rapidPeriod | number | 10000 | Rapid period in milliseconds (10 seconds) |
| logging | object | - | Logging configuration |
| logging.level | string | 'info' | Log level ('debug','info','warn','error') |
| logging.format | string | 'json' | Log format ('json' or 'text') |
| logging.customFields | string[] | [] | Additional fields to include in logs |
| logging.destination | string | - | Log file path |


### License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
