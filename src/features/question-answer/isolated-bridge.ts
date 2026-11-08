import { bridgeMessage, type BridgeMessage, type PageBridge } from '../../shared/bridge';
import { handleAnswerPageCommand } from './page';

/** Zjooc native controls need no MAIN-world access or public window messaging. */
export function createIsolatedAnswerBridge(win: Window, receive: (message: BridgeMessage) => void): PageBridge {
  let disposed = false;
  return {
    send(message) {
      if (disposed || message.kind !== 'answer-command') return;
      void handleAnswerPageCommand(win, message.command).then(result => {
        if (!disposed) receive(bridgeMessage({ kind: 'answer-result', requestId: message.requestId, result }));
      });
    },
    dispose() { disposed = true; void handleAnswerPageCommand(win, { action: 'cancel' }); },
  };
}
