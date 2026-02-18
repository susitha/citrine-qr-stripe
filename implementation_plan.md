# Implementation Plan - Session Persistence and Robustness

This plan outlines the steps to make the EV charging system more robust by persisting charging sessions, improving the transaction polling mechanism, and completing the user flow with a receipt page.

## Proposed Changes

### Database Layer

#### [MODIFY] [schema.sql](file:///Users/susithajanaka/Trial/citrine-qr-stripe/schema.sql)
- Add a `sessions` table to store active and pending charging sessions.
- Fields: `transaction_id` (PK), `charger_id`, `checkout_id`, `user_id_tag`, `status` (pending, active, completed), `created_at`, `updated_at`.

### Backend Services

#### [MODIFY] [billingService.js](file:///Users/susithajanaka/Trial/citrine-qr-stripe/billingService.js)
- Replace the in-memory `activeSessions` Map with database queries to the `sessions` table.
- Update `registerSession` to insert into the database.
- Update `checkFinishedTransactions` to query the database for sessions that are not yet marked as completed.

#### [MODIFY] [server.js](file:///Users/susithajanaka/Trial/citrine-qr-stripe/server.js)
- Refactor `startCharging` to store the initial "pending" session in the database.
- Improve the polling loop to handle potential delays in transaction appearance from CitrineOS.

#### [MODIFY] [stripeService.js](file:///Users/susithajanaka/Trial/citrine-qr-stripe/stripeService.js)
- Update `chargeCustomer` to handle payment processing more reliably (ensuring it can be called with a saved payment method or checkout session reference).

### Frontend

#### [NEW] [receipt.html](file:///Users/susithajanaka/Trial/citrine-qr-stripe/public/receipt.html)
- Create a receipt page to show the final details of a charging session (kWh delivered, total cost, etc.).

## Verification Plan

### Automated Tests
- No existing automated tests were found. I will create a basic test script `test-integration.js` to simulate the charging flow (mocking CitrineOS and Stripe responses if necessary).

### Manual Verification
1.  **QR Code Flow**: Generate a QR code, scan it (or navigate to the URL), and start a session.
2.  **Persistence Test**: Start a session, restart the server, and verify that the session is still tracked in the dashboard.
3.  **Completion Flow**: Stop the session and verify that the receipt is displayed and the customer is "charged" (logged in console).
