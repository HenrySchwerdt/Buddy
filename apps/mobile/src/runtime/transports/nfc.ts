import { Platform } from 'react-native';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import type { Bytes, NfcIso15693Tag, NfcTransport } from '@buddy/core';

const bytes = (a: number[]): Bytes => Uint8Array.from(a);
const ADDRESSED_HIGH_RATE = 0x02;

function hexToBytes(id: string): Bytes {
  return Uint8Array.from(id.match(/.{1,2}/g) ?? [], (h) => parseInt(h, 16));
}

/** NfcTransport for ISO 15693 tags (Libre) on iOS (NFCISO15693Tag) and Android (NfcV). */
export const nfcTransport: NfcTransport = {
  async isSupported() {
    try {
      return await NfcManager.isSupported(Platform.OS === 'ios' ? NfcTech.Iso15693IOS : NfcTech.NfcV);
    } catch {
      return false;
    }
  },
  async withIso15693Tag(alertMessage, session) {
    await NfcManager.start();
    const tech = Platform.OS === 'ios' ? NfcTech.Iso15693IOS : NfcTech.NfcV;
    try {
      await NfcManager.requestTechnology(tech, { alertMessage });
      const info = await NfcManager.getTag();
      const uid = hexToBytes(info?.id ?? '');
      const tag: NfcIso15693Tag =
        Platform.OS === 'ios'
          ? {
              uid,
              async transceive(cmd) {
                const [, data] = await NfcManager.iso15693HandlerIOS.sendRequest({ flags: cmd[0] ?? ADDRESSED_HIGH_RATE, commandCode: cmd[1] ?? 0, data: Array.from(cmd.slice(2)) });
                return bytes(data);
              },
              customCommand: async (code, params) => bytes(await NfcManager.iso15693HandlerIOS.customCommand({ flags: ADDRESSED_HIGH_RATE, customCommandCode: code, customRequestParameters: Array.from(params) })),
              readSingleBlock: async (block) => bytes(await NfcManager.iso15693HandlerIOS.readSingleBlock({ flags: ADDRESSED_HIGH_RATE, blockNumber: block })),
            }
          : {
              uid,
              transceive: async (cmd) => bytes(await NfcManager.nfcVHandler.transceive(Array.from(cmd))),
              customCommand: async (code, params) => bytes(await NfcManager.nfcVHandler.transceive([ADDRESSED_HIGH_RATE, code, 0x07, ...params])),
              readSingleBlock: async (block) => bytes(await NfcManager.nfcVHandler.transceive([ADDRESSED_HIGH_RATE, 0x20, block])).slice(1),
            };
      const result = await session(tag);
      if (Platform.OS === 'ios') await NfcManager.setAlertMessageIOS('Done');
      return result;
    } finally {
      await NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  },
};
