const chargerIdEl = document.getElementById('charger-id');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statusDesc = document.getElementById('status-desc');
const startBtn = document.getElementById('start-btn');
const sessionInfo = document.getElementById('active-session-info');
const userInputContainer = document.getElementById('user-input-container');
const userIdInput = document.getElementById('user-id-input');

// Get chargerId from URL
const urlParams = new URLSearchParams(window.location.search);
const chargerId = urlParams.get('chargerId') || 'A20223115843'; // Default for testing
const defaultUserId = urlParams.get('userId') || 'DRIVER_001';

// Set default value if URL has it
userIdInput.value = urlParams.get('userId') || '';

chargerIdEl.textContent = `Charger: ${chargerId}`;

/**
 * Poll charger status from API
 */
async function checkStatus() {
    try {
        const res = await fetch(`/api/charger-status/${chargerId}`);
        const data = await res.json();

        if (data.status === 'Available') {
            statusDot.className = 'status-indicator available';
            statusText.textContent = 'Available';
            statusDesc.textContent = 'Ready to start charging. Enter your Member ID below.';
            startBtn.style.display = 'block';
            userInputContainer.style.display = 'block';
            sessionInfo.style.display = 'none';
        } else {
            statusDot.className = 'status-indicator occupied';
            statusText.textContent = 'Occupied';
            statusDesc.textContent = 'A session is already active on this station.';
            startBtn.style.display = 'none';
            userInputContainer.style.display = 'none';
            sessionInfo.style.display = 'block';

            // Store transactionId for dashboard
            if (data.transactionId) {
                localStorage.setItem('activeTransactionId', data.transactionId);
            }
        }
    } catch (err) {
        console.error('Error checking status:', err);
    }
}

/**
 * Start charging session
 */
startBtn.addEventListener('click', async () => {
    const finalUserId = userIdInput.value.trim() || defaultUserId;

    if (!finalUserId) {
        alert('Please enter your Member ID / User Tag to start charging.');
        return;
    }

    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';

    try {
        // Call backend to trigger remote start
        const res = await fetch(`/create-session/${chargerId}/${finalUserId}`);

        // In our current mock implementation, this returns quickly
        // We poll status again to see if it flipped to occupied
        setTimeout(async () => {
            await checkStatus();
            if (statusText.textContent === 'Occupied') {
                window.location.href = 'dashboard.html';
            } else {
                alert('Session initiated. Redirecting to dashboard once verified...');
                // Poll every 2s until transaction is found
                const interval = setInterval(async () => {
                    await checkStatus();
                    if (statusText.textContent === 'Occupied') {
                        clearInterval(interval);
                        window.location.href = 'dashboard.html';
                    }
                }, 2000);
            }
        }, 3000);

    } catch (err) {
        alert('Failed to start charging. Please try again.');
        startBtn.disabled = false;
        startBtn.textContent = 'Start Charging';
    }
});

// Initial check and periodic polling
checkStatus();
setInterval(checkStatus, 10000);
