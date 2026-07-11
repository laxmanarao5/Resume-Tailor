document.addEventListener('DOMContentLoaded', () => {
  const jdInput = document.getElementById('jd-input');
  const extractBtn = document.getElementById('extract-btn');
  const tailorBtn = document.getElementById('tailor-btn');
  const statusCard = document.getElementById('status-card');
  const statusIndicator = document.getElementById('status-indicator');
  const statusMsg = document.getElementById('status-msg');

  function showStatus(msg, type = 'loading') {
    statusCard.style.display = 'flex';
    statusMsg.textContent = msg;
    
    // Clear all status classes
    statusIndicator.className = 'status-icon';
    
    if (type === 'loading') {
      statusIndicator.classList.add('status-loading');
    } else if (type === 'success') {
      statusIndicator.classList.add('status-success');
    } else if (type === 'error') {
      statusIndicator.classList.add('status-error');
    }
  }

  function hideStatus() {
    statusCard.style.display = 'none';
  }

  // 1. Extract JD from Active Page
  extractBtn.addEventListener('click', async () => {
    showStatus('Scanning page for job description...', 'loading');
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        showStatus('Error: No active browser tab found.', 'error');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'extract' }, (response) => {
        if (chrome.runtime.lastError) {
          showStatus('Error: Cannot scan this page. Try reloading the tab.', 'error');
          return;
        }

        if (response && response.text) {
          jdInput.value = response.text;
          showStatus('Job description successfully extracted!', 'success');
          setTimeout(hideStatus, 2500);
        } else {
          showStatus('JD not found. Please highlight target text or paste manually.', 'error');
        }
      });
    } catch (err) {
      showStatus(`Scan failed: ${err.message}`, 'error');
    }
  });

  // 2. Submit JD to Node.js Backend for Tailoring
  tailorBtn.addEventListener('click', async () => {
    const jd = jdInput.value.trim();
    if (!jd) {
      showStatus('Error: Please input a job description first.', 'error');
      return;
    }

    // Disable UI inputs during tailoring
    tailorBtn.disabled = true;
    extractBtn.disabled = true;
    jdInput.disabled = true;

    showStatus('Customizing resume with AI... (may take 10-15s)', 'loading');

    try {
      const response = await fetch('http://localhost:3000/api/tailor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jd })
      });

      if (!response.ok) {
        // Read the custom error message if available
        let errMsg = 'Failed to compile. Verify backend is running.';
        try {
          const errData = await response.json();
          errMsg = errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      showStatus('AI work complete! Compiling LaTeX into PDF...', 'loading');

      const blob = await response.blob();
      const reader = new FileReader();
      const timestamp = Date.now();
      reader.onload = () => {
        const url = reader.result;
        chrome.downloads.download({
          url: url,
          filename: `Resume_${timestamp}.pdf`,
          saveAs: true // Let the user choose where to save
        });
      };
      reader.readAsDataURL(blob);

      showStatus('Resume tailored and downloaded successfully!', 'success');

    } catch (err) {
      showStatus(`Error: ${err.message}`, 'error');
      console.error(err);
    } finally {
      // Re-enable UI inputs
      tailorBtn.disabled = false;
      extractBtn.disabled = false;
      jdInput.disabled = false;
    }
  });
});
