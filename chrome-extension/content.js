chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extract') {
    // Fallback 1: User's highlighted/selected text
    const selectedText = window.getSelection().toString().trim();
    if (selectedText) {
      sendResponse({ text: selectedText });
      return true;
    }

    // Common selectors for Job Descriptions on popular job sites
    const jdSelectors = [
      '#job-details',                       // LinkedIn newer UI
      '.jobs-description__container',       // LinkedIn older UI
      '.jobs-box__html-content',            // LinkedIn secondary UI
      '#jobDescriptionText',                // Indeed
      '.jobsearch-JobComponent-description', // Indeed secondary
      '.job-desc',                          // Naukri.com
      '.dang-inner-html',                   // Naukri React inner HTML
      'section.job-desc',                   // Naukri section
      '[class*="styles_JDC"]',              // Naukri newer React class
      '[class*="styles_job-desc"]',         // Naukri dynamic class
      '[class*="job-description"]',         // generic wildcards
      '[class*="jobDescription"]',          
      'main article',                       // general semantic HTML
      '.description'
    ];

    for (const selector of jdSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.innerText || element.textContent;
        if (text && text.trim().length > 100) {
          sendResponse({ text: text.trim() });
          return true;
        }
      }
    }

    // Fallback 2: Grab the largest text block on the page if nothing else matches
    const mainContent = document.querySelector('main') || document.body;
    const paragraphs = Array.from(mainContent.querySelectorAll('p, li'));
    const combinedText = paragraphs
      .map(el => el.innerText || el.textContent)
      .filter(txt => txt && txt.trim().length > 50)
      .join('\n\n');

    if (combinedText && combinedText.length > 200) {
      sendResponse({ text: combinedText });
    } else {
      sendResponse({ text: null });
    }
  }
  return true;
});
