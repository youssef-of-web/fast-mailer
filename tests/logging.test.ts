import { FastMailer } from '../src';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({path: path.join(__dirname, '../.env.test')});

describe('Logging Tests', () => {
    const logFile = path.join(__dirname, 'test-log.log');
    let mailer: FastMailer;

    beforeEach(() => {
        // Clear log file before each test
        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
        }

        mailer = new FastMailer({
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: true,
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            },
            from: process.env.FROM || '',
            logging: {
                level: 'debug',
                format: 'json',
                destination: logFile
            }
        });
    });

    afterEach(() => {
        // Clean up log file after tests
        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
        }
    });

    test('should create log file if it does not exist', () => {
        expect(fs.existsSync(logFile)).toBe(true);
    });

    test('should log successful email send', async () => {
        const testEmail = {
            to: 'dev.mansouriyoussef@gmail.com',
            subject: 'Test Email',
            text: 'This is a test email'
        };
    
        await mailer.sendMail(testEmail);
    
        // Wait for log to be written
        await new Promise(resolve => setTimeout(resolve, 100));
    
        const logContent = fs.readFileSync(logFile, 'utf8');
        const logEntries = logContent.trim().split('\n')
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    console.error('Failed to parse log line:', line);
                    return null;
                }
            })
            .filter(entry => entry !== null);
        
        // Changed filtering to look for any email-related entries
        const emailSendEntries = logEntries.filter(entry => 
            entry.subject === testEmail.subject &&
            entry.recipients === testEmail.to
        );

        console.log("emailSendEntries", emailSendEntries)
        
        expect(emailSendEntries.length).toBeGreaterThan(0);
        expect(emailSendEntries[1]).toMatchObject({
            success: true,
            recipients: testEmail.to,
            subject: testEmail.subject,
            level: 'info'
        });
        expect(emailSendEntries[1].messageId).toBeDefined();
        expect(emailSendEntries[1].sendTime).toBeDefined();
        expect(emailSendEntries[1].timestamp).toBeDefined();
    }, 15000);


    test('should respect log level configuration', async () => {
        const infoMailer = new FastMailer({
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: true,
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            },
            from: process.env.FROM || '',
            logging: {
                level: 'info',
                format: 'json',
                destination: logFile
            }
        });

        const testEmail = {
            to: 'test@example.com',
            subject: 'Test Email',
            text: 'This is a test email'
        };

        await infoMailer.sendMail(testEmail);
        
        // Wait longer for log to be written
        await new Promise(resolve => setTimeout(resolve, 1000));

        const logContent = fs.readFileSync(logFile, 'utf8');
        const logEntries = logContent.trim().split('\n')
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    console.error('Failed to parse log line:', line);
                    return null;
                }
            })
            .filter(entry => entry !== null);

        const debugEntries = logEntries.filter(entry => entry.level === 'debug');
        expect(debugEntries.length).toBe(0);

        const infoEntries = logEntries.filter(entry => entry.level === 'info');
        expect(infoEntries.length).toBeGreaterThan(0);
    }, 15000);

    test('should include custom fields in log entries', async () => {
        const customFieldsMailer = new FastMailer({
            host: process.env.SMTP_HOST || '',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: true,
            auth: {
                user: process.env.EMAIL_USER || '',
                pass: process.env.EMAIL_PASS || ''
            },
            from: process.env.FROM || '',
            logging: {
                level: 'info',
                format: 'json',
                destination: logFile,
                customFields: ['messageId', 'sendTime']
            }
        });

        const testEmail = {
            to: 'test@example.com',
            subject: 'Test Email',
            text: 'This is a test email'
        };

        await customFieldsMailer.sendMail(testEmail);
        
        // Wait longer for log to be written
        await new Promise(resolve => setTimeout(resolve, 1000));

        const logContent = fs.readFileSync(logFile, 'utf8');
        const logEntries = logContent.trim().split('\n')
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch (e) {
                    console.error('Failed to parse log line:', line);
                    return null;
                }
            })
            .filter(entry => entry !== null);

        const successEntry = logEntries.find(entry => entry.event === 'mail_success');
        expect(successEntry).toBeDefined();
        expect(successEntry.messageId).toBeDefined();
        expect(successEntry.sendTime).toBeDefined();
    }, 15000);
});
