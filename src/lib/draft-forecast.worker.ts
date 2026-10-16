import { buildDraftAdvisor } from './draft-advisor';
import { buildDraftForecast } from './draft-forecast';
import type { DraftForecastWorkerRequest, DraftForecastWorkerResponse } from './draft-forecast-request';

const send = (message: DraftForecastWorkerResponse) => self.postMessage(message);

self.onmessage = (event: MessageEvent<DraftForecastWorkerRequest>) => {
  const { id, mode, input } = event.data;
  try {
    let lastProgressAt = 0;
    const report = mode === 'completed'
      ? buildDraftForecast(input, progress => {
        const now = Date.now();
        if (progress.completed === progress.total || now - lastProgressAt >= 150) {
          lastProgressAt = now; send({ id, type: 'progress', ...progress });
        }
      })
      : buildDraftAdvisor(input);
    send({ id, type: 'result', report });
  } catch {
    send({ id, type: 'error', message: 'The draft analysis could not finish. Your saved imports and the official draft board have not changed.' });
  }
};
