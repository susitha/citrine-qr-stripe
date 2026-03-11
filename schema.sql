CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    id_tag VARCHAR(20) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    otp VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (email)
);

CREATE TABLE IF NOT EXISTS sessions (
    transaction_id VARCHAR(255) PRIMARY KEY,
    charger_id VARCHAR(255) NOT NULL,
    checkout_id VARCHAR(255),
    user_id_tag VARCHAR(255),
    stripe_customer_id VARCHAR(255),          -- Stripe Customer ID for off-session billing
    payment_method_id VARCHAR(255),           -- Specific payment method saved at checkout
    status ENUM('pending', 'active', 'completed') DEFAULT 'pending',
    final_charged BOOLEAN DEFAULT FALSE,      -- TRUE once kWh billing has been charged
    kwh FLOAT DEFAULT 0,
    cost FLOAT DEFAULT 0,
    start_time TIMESTAMP NULL,
    end_time TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
