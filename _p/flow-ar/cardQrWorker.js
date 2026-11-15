// Local worker only. No image, decoded URL or unlock token leaves this worker
// except the in-memory reply to the same-origin AR controller.
importScripts('./vendor/jsQR.js');
self.onmessage = ({data: request}) => {
  try {
    const result = jsQR(request.data, request.width, request.height, {inversionAttempts: 'dontInvert'});
    self.postMessage({id: request.id, text: result?.data || ''});
  } catch {
    self.postMessage({id: request.id, error: true});
  }
};
