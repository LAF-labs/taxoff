export function probeLookupPopup(probe: string): Promise<void> {
  const opener = window.opener as Window | null;
  if (!opener) return Promise.resolve();
  return new Promise((resolve) => {
    const { port1, port2 } = new window.MessageChannel();
    const done = () => {
      window.clearTimeout(timer);
      port1.close();
      resolve();
    };
    const timer = window.setTimeout(done, 500);
    port1.onmessage = done;
    try {
      opener.postMessage({ saxLookupProbe: probe }, '*', [port2]);
    } catch {
      port2.close();
      done();
    }
  });
}
