import { FastMailer } from '../src';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({path: path.join(__dirname, '../.env.test')});

describe('Attachment Tests', () => {
    const testFiles = {
        text: path.join(__dirname, 'mailer.test.ts')
    };

    beforeAll(() => {
        // Verify test files exist
        Object.entries(testFiles).forEach(([type, filePath]) => {
            if (!fs.existsSync(filePath)) {
                throw new Error(`Test file not found: ${filePath}`);
            }
        });
    });

    test('should successfully send email with multiple attachments', async () => {
        const mailer = new FastMailer({
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '465'),
            secure: true,
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            },
            from: process.env.FROM || '',
            logging: {
                level: 'debug',
                format: 'json'
            }
        });

        const result = await mailer.sendMail({
            to: process.env.TO || '',
            subject: 'Test Email with Attachments',
            text: 'This is a test email with multiple attachment types',
            attachments: [
                {
                    path: testFiles.text,
                    contentType: 'text/plain'
                }
            ]
        });

        expect(result.success).toBe(true);
        expect(result.messageId).toBeDefined();
        expect(result.timestamp).toBeInstanceOf(Date);
        expect(result.recipients).toBeDefined();

        const metrics = mailer.getMetrics();
        expect(metrics.errors_by_type.attachment).toBe(0);
    }, 30000);
});