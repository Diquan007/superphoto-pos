// Webversie als app: service worker registreren (niet in het Windows-programma)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
