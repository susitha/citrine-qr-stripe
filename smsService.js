import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import dotenv from 'dotenv';

dotenv.config();

const snsClient = new SNSClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Send an OTP via SMS using Amazon SNS
 * @param {string} phoneNumber - E.164 format e.g. +94771234567
 * @param {string} otp - 6-digit OTP code
 */
export async function sendOTPSms(phoneNumber, otp) {
    const message = `Your VoltCharge verification code is: ${otp}. It expires in 10 minutes. Do not share this code.`;

    const params = {
        Message: message,
        PhoneNumber: phoneNumber,
        MessageAttributes: {
            'AWS.SNS.SMS.SenderID': {
                DataType: 'String',
                StringValue: process.env.AWS_SNS_SENDER_ID || 'VoltCharge',
            },
            'AWS.SNS.SMS.SMSType': {
                DataType: 'String',
                StringValue: 'Transactional',
            },
        },
    };

    try {
        const command = new PublishCommand(params);
        const result = await snsClient.send(command);
        console.log(`[SMS] OTP sent to ${phoneNumber}, MessageId: ${result.MessageId}`);
        return true;
    } catch (error) {
        console.error(`[SMS] Error sending OTP to ${phoneNumber}:`, error.message);
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEV] OTP for ${phoneNumber} is: ${otp}`);
        }
        return false;
    }
}
