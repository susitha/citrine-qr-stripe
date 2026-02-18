import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

export async function sendOTPEmail(email, otp) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Your EV Charging Station OTP',
        text: `Your One-Time Password (OTP) for the EV charging system is: ${otp}. It will expire in 10 minutes.`,
        html: `<p>Your One-Time Password (OTP) for the EV charging system is: <b>${otp}</b>.</p><p>It will expire in 10 minutes.</p>`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Email] OTP sent to ${email}`);
        return true;
    } catch (error) {
        console.error(`[Email] Error sending OTP to ${email}:`, error.message);
        // In development, we might want to log the OTP to the console if email fails
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEV] OTP for ${email} is: ${otp}`);
        }
        return false;
    }
}
