import { FastMailer, MailerConfig } from '../src';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env.test') });

describe('Rate Limiting Tests', () => {
    let mailer: FastMailer;

    beforeAll(() => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setTimeout(10000); // Increase timeout to 10 seconds
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        const config: MailerConfig = {
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '465'),
            secure: true,
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            },
            from: process.env.FROM || '',
            rateLimiting: {
                perRecipient: true,
                burstLimit: 2,
                cooldownPeriod: 1000, // 1 second cooldown
                banDuration: 7200000, // 2 hour ban
                maxConsecutiveFailures: 3,
                failureCooldown: 300000 // 5 min failure cooldown
            },
            logging: {
                level: 'debug',
                format: 'text',
                destination: "./ratelimit.log"
            }
        };
        mailer = new FastMailer(config);
    });

    it('should enforce burst limit per recipient', async () => {
        const recipient = process.env.TO || '';
        const mailOptions = {
            to: recipient,
            subject: 'Test Email',
            text: 'Test content'
        };

        // Mock the internal rate limit tracking
        const mockLimits = {
            count: 2, // Already at burst limit
            lastReset: Date.now(),
            banned: false,
            banExpiry: Date.now() + 7200000,
            consecutiveFailures: 0,
            lastFailure: Date.now()
        };
        mailer['rateLimits'].set(recipient, mockLimits);

        // Should fail due to burst limit
        await expect(mailer.sendMail(mailOptions)).rejects.toMatchObject({
            code: 'ERATELIMIT',
            message: 'Rate limit exceeded for recipient',
            details: {
                type: 'rate_limit_error',
                context: {
                    recipient,
                    burstLimit: 2,
                    cooldownPeriod: 1000
                }
            }
        });
    });

    it('should reset rate limits after cooldown period', async () => {
        const recipient = process.env.TO || '';
        const mailOptions = {
            to: recipient,
            subject: 'Test Email',
            text: 'Test content'
        };

        // Mock initial rate limit state
        const mockLimits = {
            count: 2,
            lastReset: Date.now() - 1100, // Just over cooldown period ago
            banned: false,
            banExpiry: Date.now() + 7200000,
            consecutiveFailures: 0,
            lastFailure: Date.now()
        };
        mailer['rateLimits'].set(recipient, mockLimits);

        // Should be able to send after cooldown
        await expect(mailer.sendMail(mailOptions)).resolves.toMatchObject({ success: true });
    }, 10000); // Increase timeout to 10 seconds

    it('should handle consecutive failures and temporary bans', async () => {
        const recipient = process.env.TO || '';
        const mailOptions = {
            to: recipient,
            subject: 'Test Email',
            text: 'Test content'
        };

        // Mock banned state
        const banExpiry = Date.now() + 7200000;
        const mockLimits = {
            count: 0,
            lastReset: Date.now(),
            banned: true,
            banExpiry,
            consecutiveFailures: 3,
            lastFailure: Date.now()
        };
        mailer['rateLimits'].set(recipient, mockLimits);

        // Attempt should fail due to ban
        await expect(mailer.sendMail(mailOptions)).rejects.toMatchObject({
            code: 'ERATELIMIT',
            message: 'Recipient is temporarily banned due to rate limit violations or consecutive failures',
            details: {
                type: 'rate_limit_error',
                context: {
                    recipient,
                    consecutiveFailures: 3,
                    banExpiry: expect.any(String)
                }
            }
        });

        // Clear the rate limits
        mailer['rateLimits'].delete(recipient);

        // Should be able to send again after clearing limits
        await expect(mailer.sendMail(mailOptions)).resolves.toMatchObject({ success: true });
    }, 10000); // Increase timeout to 10 seconds

    it('should track rate limit metrics', async () => {
        const recipient = process.env.TO || '';
        const mailOptions = {
            to: recipient,
            subject: 'Test Email',
            text: 'Test content'
        };

        // Mock rate limit exceeded state
        const mockLimits = {
            count: 2,
            lastReset: Date.now(),
            banned: false,
            banExpiry: Date.now() + 7200000,
            consecutiveFailures: 0,
            lastFailure: Date.now()
        };
        mailer['rateLimits'].set(recipient, mockLimits);

        try {
            await mailer.sendMail(mailOptions);
        } catch (error) {
            // Expected error
        }

        const metrics = mailer.getMetrics();
        expect(metrics.rate_limit_exceeded_total).toBeGreaterThan(0);
        expect(metrics.current_rate_limit_window).toBeDefined();
    });
});
