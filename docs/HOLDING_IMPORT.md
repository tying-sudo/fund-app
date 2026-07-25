# Holding Import

The holdings page supports two import paths:

- Android JD Cookie import synchronizes the current fund holdings snapshot and asks the fixed JD Finance endpoint for the latest 30-day transaction window.
- AI image import sends a selected screenshot to the server-side AI OCR endpoint.

The supplied JD Cookie is saved only in the local browser or Android WebView storage so the next import form can restore it. It is never logged, returned by the native plugin, or sent to this application's backend; it is passed only to JD's fixed holdings endpoints. The import form provides a delete action that removes the saved Cookie from that device. The response exposes only normalized current fund rows and recent buy, redemption, or conversion records needed by the import confirmation flow. A cleared fund is not re-created from history: only funds present in JD's current-holdings snapshot are added or updated. Recent transaction rows are stored as deduplicated audit records and never applied a second time on top of that authoritative snapshot.

The old browser Tesseract OCR path has been removed. AI image recognition remains available through `POST /api/ocr/holding-import`.
