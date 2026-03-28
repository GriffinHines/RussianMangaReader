chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FETCH_IMAGE_AS_DATA_URL") {
    (async () => {
      try {
        const url = message.url;
        if (!url) {
          sendResponse({ ok: false, error: "No URL provided" });
          return;
        }

        const response = await fetch(url, {
          method: "GET",
          credentials: "include"
        });

        if (!response.ok) {
          sendResponse({
            ok: false,
            error: `HTTP ${response.status} ${response.statusText}`
          });
          return;
        }

        const blob = await response.blob();

        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({
            ok: true,
            dataUrl: reader.result
          });
        };
        reader.onerror = () => {
          sendResponse({
            ok: false,
            error: "Failed converting blob to data URL"
          });
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err)
        });
      }
    })();

    return true;
  }

  if (message?.type === "CAPTURE_VISIBLE_TAB") {
    chrome.tabs.captureVisibleTab(
      sender.tab?.windowId,
      { format: "png" },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }

        sendResponse({
          ok: true,
          dataUrl
        });
      }
    );

    return true;
  }
});