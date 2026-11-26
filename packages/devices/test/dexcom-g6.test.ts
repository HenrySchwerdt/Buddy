/**
 * Dexcom G6 tests. The protocol vectors are ported from the CGMBLEKitTests of
 * loopandlearn/CGMBLEKit (MIT, © LoopKit Authors); the end-to-end tests drive the driver
 * against the transmitter simulator over the in-memory BLE fake.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemorySecretStore, fromHex, hex, silentLogger, type Clock, type DeviceContext } from '@buddy/core';
import {
  appendBackfillFrame,
  appendingCrc,
  backfillByteCount,
  backfillCrc16,
  backfillGlucose,
  CalibrationState,
  computeHash,
  createBackfillFrameBuffer,
  createDexcomG6Source,
  dexcomG6Cgm,
  g6StateKey,
  glucoseBackfillTx,
  hasValidSensorSession,
  isAnubis,
  isCrcValid,
  makeGlucose,
  normalizeTransmitterId,
  parseCalibrationDataRx,
  parseGlucoseBackfillRx,
  parseGlucoseRx,
  parseSessionStartRx,
  parseSessionStopRx,
  parseTransmitterTimeRx,
  parseTransmitterVersionRx,
  transmitterStatus,
  type BackfillFrameBuffer,
} from '../src/dexcom-g6';
import { trendFromRate } from '../src/dexcom-g6/ble-common';
import { createG6Simulator, encodeGlucoseRx } from '../src/dexcom-g6/simulator';
import { createFakeBle } from '../src/testkit';

const bytes = (h: string) => fromHex(h);
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const fill = (identifier: number, frames: readonly string[]): BackfillFrameBuffer =>
  frames.reduce((b, f) => appendBackfillFrame(b, bytes(f)), createBackfillFrameBuffer(identifier));

// Frame vectors from GlucoseBackfillMessageTests.testNotGlucoseBackfill1/2/3 (CGMBLEKit).
const NOT_BACKFILL_1: readonly string[] = [
  '01c04a4f4a5558ef554453b7392a0df008571a7f',
  '02c0451e0d74bdec596b633cf2b03d511ef3d048',
  '03c009145e959ca51f7a1663ca31676b175d7bc7',
  '04c0de00c954fcd3281d5163ed873cdc136fca3e',
  '05c0c7da188dd5fbb8997206da1cc8d0c22f8434',
  '06c04d50b29df06b12e7162f2d73fd553e44e469',
  '07c02b4bb61d66cf6e949ee0f07dbe0cc12127ae',
  '08c03bf887be09ece7595adfee494b25368103b4',
  '09c07eefb9b5398468a53f00355341d19b50c8b1',
  '0ac028f0ddb4dc09a2c74deedf7fdff13fcd6b0e',
  '0bc0ad2d7311ac9ec1908fb7ee5557c463ea4fea',
  '0cc0bf3c62d9aa62d7c3d447c959b51d31fd016d',
  '0dc0278116abd1252ad66c894a39ed7c6d72086e',
  '0ec0aaee3bf9b05ccb7b23e1c27d777173c4d9fd',
  '0fc044048720d76a696249737f999f944995e44e',
  '10c0495e4cb7f22327a920a843de1b4522a68108',
  '11c058c482389192ed920e322b71900d747a9492',
  '12c0eac06906ff4863f0e8da07d1ead29fc15bd3',
  '13c0c0be38548fe9e229c64c9c0f3e9b4c4c1d83',
  '14c018a936bdde548e4244093e77c87adda0a1cf',
  '15c0fb97d1d147dd0bc6552faa4d62ab553e1682',
  '16c0f15f8cb77decb934bfe0c711a026dd4bf36b',
  '17c0bd268b0eee07ed20a0f3856ea449b1503708',
  '18c00872ed5a996a13480b81fc82b6ca1e7dd379',
  '19c06fb4c5bc84e63688b0a77edbab85bfb61b45',
  '1ac071d29d30edb43db6b8e114bbbcd67f9dd3a9',
  '1bc0569e17a8a80c015def11ddce1b8f194ff6e2',
  '1cc0df79ffbc1e077fe249b47550feb5dcd53044',
  '1dc0b557e2ba03caed61de30221b0330e1cc49b1',
  '1ec006f05e739d737939baf8b14a8b7a6faae96e',
  '1fc00b82d430e9e75fb8e7e2affbdd292a41fad2',
  '20c0fbf8e8f2686aaaf19d2809eecd3bd4f63516',
  '21c0a7df809e73538e459c1a9cd27a566f636e22',
  '22c0dbb3c23d7d7847dee77311287e6c6b192eb4',
  '23c0d30038d70241a80b9e390778a897dd1632cc',
  '24c0177b23127b464c07a499abeff05f13e40998',
  '25c0855350c7c4a335e95d2e569996639e8341b4',
  '26c0d42874475710a50764d4a4166c0e420aff7f',
  '27c0facb1d61cb8057de64546fc9f24f93603093',
  '28c080befb84f22c60d398f017dde114d0557b27',
  '29c07555e92425342c0674b62fa517b13ba0e3b0',
  '2ac0923624bce36c89fade1f66bd7ae1e8e7d598',
  '2bc0d345ceea668373d31f95b03a6ee7fff1a3b5',
  '2cc045e409b8d31dd53ae9d353f35738819fbb79',
  '2dc0a5d31fd3c3b7b217d3f79b245d3714b0523d',
  '2ec0eb576e0193584bff8ecada0dc54e4ebde86c',
  '2fc092b8ef52003f8b76e90d920ca738c998bb70',
  '30c07cfa0f7a69d14b79f605d254a164fd67c658',
  '31c049a329162e03f41c12db845b73301f5bbb81',
  '32c08a21ca0995b5aa413897ea9e2b7c563ced07',
  '33c05d51a18e19209f1c55054bd2f74677c71070',
  '34c0299e29ae5576a220b0b767fc4e898aaf2df1',
  '35c0bbb554546b69c53b4b3a63bd524bfbe728e6',
  '36c0cd4e8c6e10e72950e66bfa0d23b954a7aede',
  '37c0ea5df836af737298d44b4b156ced47727920',
  '38c02303edefc4916cfdba55829426c153d0d30c',
  '39c0dfee091fea60c2da239c9aabef8eddbe49b5',
  '3ac02788f23fb030e7606329ed24cbee10bc20eb',
  '3bc00a601d46c10bab8cdf04513a47550b0e4fe5',
  '3cc072ea5e514432c81e325464e1ac2d659378d2',
  '3dc0f050e994caa508fdea7202ed70a4acc6e8ab',
  '3ec069ab0d13863943415b492569db29b9594dbe',
  '3fc02c37277a98b88956f0def9ad866f44ca6d9f',
  '40c0e5bd6aa2dbd835fab2ec238de4a635a3f6cb',
  '41c0aafa8812d94d5fe722b3ecfb74eb4c12c622',
  '42c08c5b4bb2f28069fc6f9dcb26bc84c0cc01c7',
  '43c04ad95cefa1f62a18fa2c5a05bac208685cdb',
  '44c0ffe910ddc010b30f457578ab24a866b8a94d',
  '45c01b0bb36e58f401eb15da2e6710721e39c573',
  '46c06165075618fc9626c53acdd9cb8bcfb0719f',
  '47c081599f76725e30d4de39cdcc7f7c0c918d68',
  '48c0563b99dce4913105b793f4d539fe668feef6',
  '49c04ebaaf9f4dfda6cac4d617cd07098fec39f0',
  '4ac04c1ae961bc4f3e2cd395396dc8098bbf4bd5',
  '4bc0d95ed88f296e8d68c35085af86e5ef8d8bf0',
  '4cc0658ccce111259ce8ac5cbedfc46deda77433',
  '4dc05fda2f8d2885082db4b1356c5e2a0e830471',
  '4ec066c7813ff84a9da11fe343e5a95bbfa3082c',
  '4fc03bcfd6fe6d9657d04f06ed7bc461ebe18d47',
  '50c035bbe880ba24d7c84f73ae061b33d62a1845',
  '51c0650f0a6bbc91b2771549cf49a5a4faf8b278',
  '52c07ac551477e6cd10fe6a3b43d62b02569d110',
  '53c005f79d6de0ec017e7a0c98961ce6770f885d',
  '54c0d05fee0b5f5bf9de8c61b58f8634ecbf3347',
  '55c0e0c7d345fbc40f35aed12e82f8ccb0ed9335',
  '56c0b1c8b263179e',
];
const NOT_BACKFILL_2: readonly string[] = [
  '0180cde3fd48248e37a7bf6c2d9d78d4bfef6d5b',
  '02809f074c9039b6d3b841f422cf36398338f98c',
  '038004160a5a1ad37c382f3ca23ea215c644f7b6',
  '04802ed7376fa7c83c3ecf0b645233f9b3c80238',
  '05805692724e630a703f01b0a942250f725553d2',
  '06804ca2727a4051033a550da80905caf77c735d',
  '07808f937b4b9602c5dd6fa13ae983e00783b28e',
  '088069846e672c106b339159ead9ee1c08e1a159',
];
const NOT_BACKFILL_3: readonly string[] = [
  '0180e1234bdf92845cec52822a8894854582b2b2',
  '02800f8a38cc876ad33ae0acdc25921132cc6f0d',
  '038032a6cd9e6d447916dd0b9699e499ae79b8d1',
  '048045f4b95e0ad80955d3a899d6083bd142f863',
  '05809cf9c189744ab66f6ca5c2833ef27442fa71',
  '068053694b279275f0d23eb826681e20e5ebb79d',
  '078098b921155eb5aed63119d5faec3ef3e53a37',
  '08807c87277557a0828e8dc81ff76f1a6e197103',
  '0980b8378b133898ce73f7989d67360123e9fdd8',
  '0a80383ce19d943a38796b594ff95a2dc93bd6a2',
  '0b806b548c5997dc67ed4fe07bcf236d59dd7f94',
  '0c802cb2382f40a06fde5f2dff3f0b8226a11f12',
  '0d8029800ae513c5b7bc8ea733544b7da84ded17',
  '0e80a95b6c3d36183e4409f916a6f1f775af338e',
  '0f80d098732f2abcf4a90628f321a048349142ff',
  '108077294e9d029bdc0602c76671d88ff4a87596',
  '1180bac50f8d705f6732c34b935a0b06545d6d8f',
  '1280cf6b9eb0d2f0059c1a7b5c65acb83eb43836',
  '13802f408f68fc7e48858daecf64d01f3f61827e',
  '1480cd5975c1062ed45311a2602c0bbc9c78cf21',
  '1580b6e27f3350bc7d4eb908313710931cbd4f23',
  '168061f70e5e27e8b72faecfbb58b6b6ff65cbf0',
  '178066bdd3a0b1e1ed0af8b2af88dcb1f4b1c3a4',
  '18801eb9326019bca25b74804d196c04d079e495',
  '1980a29097393f81aaef79ef421af54ccd3c35ed',
  '1a80a3039b0372ddd79ef65293e4e99484573ab3',
  '1b807e755140ea79b1913a7c491e606b7d1e4542',
  '1c800c968daf03958bd8784e1cf8cea4fa903a80',
  '1d8044c5c7baebadbf8e6877d725ab84484e6755',
  '1e8036be160e8a03d2c07552fc513c8869170528',
  '1f8038483ab634e7707e9ab8c8e3f87dd67f423f',
  '2080f184e4457558d9b7944f21d6421b717ddfb1',
  '2180bb4da6197852102a3a04b8acccea3c54f0f9',
  '2280da93975f3ea1c39d2aff5dbbc4b183b66044',
  '23804678951cdc83923fe5a88bda66221a48360b',
  '2480aa9dc3fee16106bd551754d896da72ff772c',
  '2580b825bb4eba580b57caadda1b90b449a8f2c5',
  '2680117b62c286b395d2bf016848c65953595f19',
  '27806d524b2b191bd9582f47fd3956ab851207af',
  '2880c7df85c2ee5e9b3f5ae68ffba44a86e237e8',
  '2980947fec3646851a510c8a61c0b3b7d90e410b',
  '2a8014b04b3ff32e4d9d16f46880533cf4562af4',
  '2b80c754e48edfa84f2f3b29976ce59cc110747d',
  '2c8095a3ab4b66254954a51ca5e5c92d07be80fc',
  '2d80bc4afa73d7f222f1b9e56083171057e32ca3',
  '2e80c88dbe9a052d7ffd29d2f665bdd66811712f',
  '2f804d2f9ee36fd6f3f48c30429c1629e39bbe3f',
  '30808b01f598fc6420d85b3190d15f8d55f43faf',
  '31801c171908c8ded10e81123f453c571c8f5199',
  '32806275a5652f2447f63f1ab5d0dac84387d80c',
  '3380f095361816ab06f0209a6ec3411c8f0c6ce1',
  '3480a99ac0dae0c87f6a1d4ee4fe4e19671c29ba',
  '3580811db50e1625a3b88305ea5c34b53e20700e',
  '36800fbf211b6a454c788aa17b0cf14db76695a9',
  '3780dfc186d1c189114f182709efc464f48c6b2f',
  '38805e629e8e6457b1ec149897210cb6336b123f',
  '398045d4dc9f4c074ec0e926a8d1768ae92b4866',
  '3a801edf0d5d1c1a86c90c5eeef69e115fdd513a',
  '3b8084223228b158081b465c74454450ec19a4c1',
  '3c80fa306d71fc211bd9b9e55aeb16c582d21ec2',
  '3d8072d8bbec74f1436958db431a92fc66cf5dd2',
  '3e80888ef69a91f8dbb0ce70b6e5ec9289245878',
  '3f8069c0d6d14e580be92f87a3255e124b25b451',
  '4080b3cbae3d50ea52720bf5029243a4a9fea906',
  '4180384321d07a4b5378aa272c9a7247830624b8',
  '4280acf0b265dd82b68aeec5114161a34135b30e',
  '43802d709c604266db64a4b5a5e6f6d8cfd7ece1',
  '44807b48711b0630cd919dbf9ea7bf81efa1e8f1',
  '4580c0282b679f9746ece875482d5e9a5ed59cb8',
  '46808c7b718de4299f081449cce9aa9afadfcea9',
  '478066cd4c36d6e816413b15955c958da4d8e866',
  '48809b5170078157c542236bc7a09c96bc559069',
  '49800be65a0bce639c69cd3d64db0fa22570756f',
  '4a80e5ebd5381b077a8ac56e952b631256a076cc',
  '4b80fb32d28e39021d49dc7b7ee65272ca1f28c1',
  '4c8004486cc3dcad9f39c602d3ed9030e327cec3',
  '4d809a5800c6d647c5f99e40a15327957745dce1',
  '4e80d03a0b5368fda78b28d3975500ab160ac693',
  '4f80dbc5ea65f540933f858a425ecdb378f62990',
  '50802e7980ce9365ad4e434308fb2a8102dc9f6a',
  '5180b71311e183ad9feecfd43b68072d5a9ad4af',
  '5280e721c37d2b57f95cbf5f51025fb22b6ca60c',
  '53805749eb01f070a5b015dcd0f68f5fea0b40c6',
  '5480fae4ee747357e4d73265ad9411c565c41865',
  '5580b75e9c62c7c2aa3ea3f94d219ef7330077d7',
  '5680f2c59ee6b54a',
];

describe('Dexcom G6 messages (ported CGMBLEKitTests)', () => {
  it('GlucoseRxMessage: message data', () => {
    const m = parseGlucoseRx(bytes('3100680a00008a715700cc0006ffc42a'))!;
    expect(m.status).toBe(0);
    expect(m.sequence).toBe(2664);
    expect(m.glucose.timestamp).toBe(5730698);
    expect(m.glucose.glucoseIsDisplayOnly).toBe(false);
    expect(m.glucose.glucose).toBe(204);
    expect(m.glucose.state).toBe(6);
    expect(m.glucose.trend).toBe(-1);
  });

  it('GlucoseRxMessage: negative trend, display only, old transmitter, zero sequence', () => {
    const neg = parseGlucoseRx(bytes('31006f0a0000be7957007a0006e4818d'))!;
    expect([neg.sequence, neg.glucose.timestamp, neg.glucose.glucose, neg.glucose.trend]).toEqual([2671, 5732798, 122, -28]);
    const disp = parseGlucoseRx(bytes('3100700a0000f17a5700584006e3cee9'))!;
    expect([disp.sequence, disp.glucose.timestamp, disp.glucose.glucose, disp.glucose.trend]).toEqual([2672, 5733105, 88, -29]);
    expect(disp.glucose.glucoseIsDisplayOnly).toBe(true);
    const old = parseGlucoseRx(bytes('3100aa00000095a078008b00060a8b34'))!;
    expect([old.sequence, old.glucose.timestamp, old.glucose.glucose, old.glucose.trend]).toEqual([170, 7905429, 139, 10]);
    const zero = parseGlucoseRx(bytes('3100000000008eb14d00820006f6a038'))!;
    expect([zero.sequence, zero.glucose.timestamp, zero.glucose.glucose, zero.glucose.trend]).toEqual([0, 5091726, 130, -10]);
  });

  it('rejects a glucose message with a bad CRC or wrong opcode', () => {
    expect(parseGlucoseRx(bytes('3100680a00008a715700cc0006ffc42b'))).toBeNull();
    expect(parseGlucoseRx(appendingCrc(bytes('3200680a00008a715700cc0006ff')))).toBeNull();
    expect(parseGlucoseRx(appendingCrc(bytes('4f00680a00008a715700cc0006ff')))?.glucose.glucose).toBe(204);
  });

  it('TransmitterTimeRxMessage: no session / in session', () => {
    for (const [h, t] of [
      ['2500e8f87100ffffffff010000000a70', 7469288],
      ['250096fd7100ffffffff01000000226d', 7470486],
      ['2500eeff7100ffffffff010000008952', 7471086],
    ] as const) {
      const m = parseTransmitterTimeRx(bytes(h))!;
      expect(m.status).toBe(0);
      expect(m.currentTime).toBe(t);
      expect(m.sessionStartTime).toBe(0xffffffff);
      expect(hasValidSensorSession(m)).toBe(false);
    }
    const a = parseTransmitterTimeRx(bytes('2500470272007cff710001000000fa1d'))!;
    expect([a.currentTime, a.sessionStartTime, hasValidSensorSession(a)]).toEqual([7471687, 7470972, true]);
    const b = parseTransmitterTimeRx(bytes('2500beb24d00f22d4d000100000083c0'))!;
    expect([b.currentTime, b.sessionStartTime, hasValidSensorSession(b)]).toEqual([5092030, 5058034, true]);
  });

  it('SessionStartRxMessage / SessionStopRxMessage', () => {
    const starts = [
      ['2700014bf871004bf87100e9f8710095d9', 7469131, 7469289],
      ['2700012bfd71002bfd710096fd71000f6a', 7470379, 7470486],
      ['2700017cff71007cff7100eeff7100aeed', 7470972, 7471086],
    ] as const;
    for (const [h, start, tx] of starts) {
      const m = parseSessionStartRx(bytes(h))!;
      expect([m.status, m.received, m.requestedTime, m.sessionStartTime, m.transmitterTime]).toEqual([0, 1, start, start, tx]);
    }
    const stops = [
      ['29000128027200ffffffff47027200ba85', 7471656, 7471687],
      ['2900013ffe7100ffffffffc2fe71008268', 7470655, 7470786],
      ['290001f5fb7100ffffffff6afc7100fa8a', 7470069, 7470186],
    ] as const;
    for (const [h, stop, tx] of stops) {
      const m = parseSessionStopRx(bytes(h))!;
      expect([m.status, m.received, m.requestedTime, m.sessionStartTime, m.transmitterTime]).toEqual([0, 1, stop, 0xffffffff, tx]);
    }
  });

  it('CalibrationDataRxMessage', () => {
    expect(parseCalibrationDataRx(bytes('33002b290090012900ae00800050e929001225'))).not.toBeNull();
  });

  it('TransmitterVersionRxMessage', () => {
    const m = parseTransmitterVersionRx(bytes('4b0001000011df2900005100037000f00009b6'))!;
    expect(m.status).toBe(0);
    expect(m.firmwareVersion).toEqual([1, 0, 0, 17]);
  });

  describe('Anubis detection', () => {
    const payload = (expiryDays: number) =>
      appendingCrc(new Uint8Array([0x4b, 0x00, 0x01, 0x00, 0x00, 0x11, 0xdf, 0x29, 0x00, 0x00, 0x51, 0x00, 0x03, expiryDays & 0xff, (expiryDays >> 8) & 0xff, 0xf0, 0x00]));
    it('stock G6 (90), Anubis (180), odd (112)', () => {
      for (const [days, anubis] of [[90, false], [180, true], [112, false]] as const) {
        const m = parseTransmitterVersionRx(payload(days))!;
        expect(m.transmitterExpiryInDays).toBe(days);
        expect(isAnubis(m)).toBe(anubis);
      }
    });
    it('rejects wrong opcode, invalid CRC and wrong length', () => {
      const wrongOpcode = payload(90).slice(0, -2);
      wrongOpcode[0] = 0x4c;
      expect(parseTransmitterVersionRx(appendingCrc(wrongOpcode))).toBeNull();
      const badCrc = payload(90);
      badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 0xff;
      expect(parseTransmitterVersionRx(badCrc)).toBeNull();
      expect(parseTransmitterVersionRx(payload(90).slice(0, -1))).toBeNull();
    });
  });

  it('CRC is CCITT XModem (init 0)', () => {
    expect(isCrcValid(bytes('3100680a00008a715700cc0006ffc42a'))).toBe(true);
    // Standard XModem check value: CRC("123456789") = 0x31C3, appended little-endian.
    expect(hex(appendingCrc(new TextEncoder().encode('123456789'))).slice(-4)).toBe('c331');
    // glucoseBackfillTx vector covers appendingCrc end to end.
    expect(hex(glucoseBackfillTx({ byte1: 5, byte2: 2, identifier: 0, startTime: 5439415, endTime: 5440614 }))).toBe('50050200b7ff5200660453000000000000007138');
  });
});

describe('Dexcom G6 auth (TransmitterIDTests)', () => {
  it('computes the AES-ECB challenge hash', () => {
    expect(hex(computeHash('123456', bytes('0123456789abcdef'))!)).toBe('e60d4a7999b0fbb2');
  });
  it('rejects non-8-byte input', () => {
    expect(computeHash('123456', bytes('0123'))).toBeNull();
  });
  it('validates the transmitter ID format', () => {
    expect(normalizeTransmitterId(' 8g12ab ')).toBe('8G12AB');
    expect(() => normalizeTransmitterId('12345')).toThrow(/6 letters/);
    expect(() => normalizeTransmitterId('12345!')).toThrow();
  });
});

describe('Dexcom G6 backfill (GlucoseBackfillMessageTests)', () => {
  it('Tx message', () => {
    expect(hex(glucoseBackfillTx({ byte1: 5, byte2: 2, identifier: 0, startTime: 4648682, endTime: 4650182 }))).toBe('50050200eaee4600c6f446000000000000009f6d');
  });

  it('Rx message and frame buffer', () => {
    const m = parseGlucoseBackfillRx(bytes('51000100b7ff52006604530032000000e6cb9805'))!;
    expect(transmitterStatus(m.status)).toBe('ok');
    expect([m.backfillStatus, m.identifier, m.startTime, m.endTime, m.bufferLength, m.bufferCrc]).toEqual([1, 0, 5439415, 5440614, 50, 0xcbe6]);
    const buffer = fill(m.identifier, ['0100bc460000b7ff52008b0006eee30053008500', '020006eb0f025300800006ee3a0353007e0006f5', '030066045300790006f8']);
    expect(backfillByteCount(buffer)).toBe(m.bufferLength);
    expect(backfillCrc16(buffer)).toBe(m.bufferCrc);
    const g = backfillGlucose(buffer);
    expect(g.map((x) => [x.glucose, x.timestamp, x.state, x.trend])).toEqual([
      [139, 5439415, CalibrationState.ok, -18],
      [133, 5439715, CalibrationState.ok, -21],
      [128, 5440015, CalibrationState.ok, -18],
      [126, 5440314, CalibrationState.ok, -11],
      [121, 5440614, CalibrationState.ok, -8],
    ]);
    expect(g[0]!.timestamp).toBe(m.startTime);
    expect(g[g.length - 1]!.timestamp).toBe(m.endTime);
  });

  const cases = [
    { rx: '51000103eaee4600c6f446003a0000004f3ac9e6', id: 0xc0, ident: 3, start: 4648682, end: 4650182, len: 58, crc: 0x3a4f, count: 6,
      frames: ['01c06e3c0000eaee4600920007fd16f046009500', '02c0070042f14600960007026ef2460099000704', '03c09af3460093000700c6f44600900007fc'] },
    { rx: '510001023d6a0e00c16d0e00280000005b1a9154', id: 0x80, ident: 2, start: 944701, end: 945601, len: 40, crc: 0x1a5b, count: 4,
      frames: ['0180440c00003d6a0e005c0007fe696b0e005d00', '028007ff956c0e005e000700c16d0e005d000700'] },
    { rx: '51000103c9740e004d780e0028000000235bd94c', id: 0xc0, ident: 3, start: 947401, end: 948301, len: 40, crc: 0x5b23, count: 4,
      frames: ['01c04d0c0000c9740e005a000700f5750e005800', '02c007ff21770e00590007ff4d780e0059000700'] },
  ];
  it.each(cases)('backfill $start-$end', (c) => {
    const r = parseGlucoseBackfillRx(bytes(c.rx))!;
    expect([r.status, r.backfillStatus, r.identifier, r.startTime, r.endTime, r.bufferLength, r.bufferCrc]).toEqual([0, 1, c.ident, c.start, c.end, c.len, c.crc]);
    const buffer = fill(c.id, c.frames);
    expect(backfillByteCount(buffer)).toBe(r.bufferLength);
    expect(backfillCrc16(buffer)).toBe(r.bufferCrc);
    const g = backfillGlucose(buffer);
    expect(g.length).toBe(c.count);
    expect(g[0]!.timestamp).toBe(r.startTime);
    expect(g[g.length - 1]!.timestamp).toBe(r.endTime);
  });

  it('malformed backfill yields only complete records', () => {
    const buffer = fill(0, ['0100bc460000b7ff52008b0006eee30053008500', '020006eb0f025300800006ee3a0353007e0006']);
    expect(backfillGlucose(buffer).length).toBe(3);
  });

  it('ignores out-of-order frames and frames of another identifier', () => {
    const b = fill(0, ['0200aaaa', '0100bc460000b7ff52008b0006eee30053008500', '0101bbbb']);
    expect(b.frames.length).toBe(1);
  });

  const notBackfill = [
    { name: '1', rx: '5100010339410e0085a90e00ac06000070ca9143', id: 0xc0, ident: 3, start: 934201, end: 960901, len: 1708, crc: 0xca70, count: 191, frames: NOT_BACKFILL_1, ordered: undefined },
    { name: '2', rx: '51000102b1aa0e00e5b20e00a000000020a39b7e', id: 0x80, ident: 2, start: 961201, end: 963301, len: 160, crc: 0xa320, count: 17, frames: NOT_BACKFILL_2, ordered: false },
    { name: '3', rx: '51000102b6a36500010c6600ac0600000147db0a', id: 0x80, ident: 2, start: 6661046, end: 6687745, len: 1708, crc: 0x4701, count: 191, frames: NOT_BACKFILL_3, ordered: false },
  ];
  it.each(notBackfill)('non-glucose backfill $name does not match the announced interval', (c) => {
    const r = parseGlucoseBackfillRx(bytes(c.rx))!;
    expect([r.status, r.backfillStatus, r.identifier, r.startTime, r.endTime, r.bufferLength, r.bufferCrc]).toEqual([0, 1, c.ident, c.start, c.end, c.len, c.crc]);
    const buffer = fill(c.id, c.frames);
    expect(backfillByteCount(buffer)).toBe(r.bufferLength);
    expect(backfillCrc16(buffer)).toBe(r.bufferCrc);
    const g = backfillGlucose(buffer);
    expect(g[0]!.timestamp).not.toBe(r.startTime);
    expect(g[g.length - 1]!.timestamp).not.toBe(r.endTime);
    if (c.ordered === false) expect(g[0]!.timestamp <= g[g.length - 1]!.timestamp).toBe(false);
    expect(g.length).toBe(c.count);
  });
});

describe('Dexcom G6 Glucose (GlucoseTests)', () => {
  const timeMessage = parseTransmitterTimeRx(bytes('2500470272007cff710001000000fa1d'))!;
  const activationDate = utc(2016, 10, 1);
  const glucose = (h: string, t = timeMessage) => {
    const m = parseGlucoseRx(bytes(h))!;
    return makeGlucose({ transmitterId: '123456', status: m.status, glucoseMessage: m.glucose, timeMessage: t, activationDate });
  };

  it('message data → dates, session, value', () => {
    const g = glucose('3100680a00008a715700cc0006ffc42a');
    expect(g.status).toBe('ok');
    expect(g.readDate).toBe(utc(2016, 12, 6, 7, 51, 38));
    expect(g.sessionStartDate).toBe(utc(2016, 12, 26, 11, 16, 12));
    expect(g.sessionExpDate).toBe(utc(2017, 1, 5, 11, 16, 12));
    expect(g.isDisplayOnly).toBe(false);
    expect(g.glucose).toBe(204);
    expect(g.state).toBe(CalibrationState.ok);
    expect(g.trend).toBe(-1);
    expect(g.syncIdentifier).toBe('123456 5730698');
  });

  it('no session does not derive future session dates', () => {
    const noSession = parseTransmitterTimeRx(bytes('2500e8f87100ffffffff010000000a70'))!;
    const g = glucose('3100680a00008a715700cc0006ffc42a', noSession);
    expect(g.sessionStartDate).toBeNull();
    expect(g.sessionExpDate).toBeNull();
    expect(g.readDate).toBe(utc(2016, 12, 6, 7, 51, 38));
  });

  it('negative trend, display only, old transmitter', () => {
    expect(glucose('31006f0a0000be7957007a0006e4818d').readDate).toBe(utc(2016, 12, 6, 8, 26, 38));
    const d = glucose('3100700a0000f17a5700584006e3cee9');
    expect([d.readDate, d.isDisplayOnly, d.glucose]).toEqual([utc(2016, 12, 6, 8, 31, 45), true, 88]);
    expect(glucose('3100aa00000095a078008b00060a8b34').readDate).toBe(utc(2016, 12, 31, 11, 57, 9));
  });

  it('unreliable states and values below 39 have no glucose; others are clamped to 40…400', () => {
    const mk = (value: number, state: number) =>
      makeGlucose({ transmitterId: '1', status: 0, glucoseMessage: { timestamp: 1, glucoseIsDisplayOnly: false, glucose: value, state, trend: 0 }, timeMessage, activationDate }).glucose;
    expect(mk(120, CalibrationState.warmup)).toBeNull();
    expect(mk(120, 99)).toBeNull();
    expect(mk(38, CalibrationState.ok)).toBeNull();
    expect(mk(39, CalibrationState.ok)).toBe(40);
    expect(mk(401, CalibrationState.ok)).toBe(400);
    expect(mk(450, CalibrationState.ok)).toBeNull();
    expect(mk(120, CalibrationState.needCalibration7)).toBe(120);
  });

  it('trend thresholds (LoopKit)', () => {
    expect([-30, -20, -10, -1, 9, 10, 20, 30].map((t) => trendFromRate(t / 10))).toEqual([
      'doubleDown', 'singleDown', 'fortyFiveDown', 'flat', 'flat', 'fortyFiveUp', 'singleUp', 'doubleUp',
    ]);
  });
});

// ── end to end ─────────────────────────────────────────────────────────────────

const NOW = utc(2026, 1, 15, 12, 0, 0);
const fixedClock: Clock = { now: () => NOW };
const ctxWith = (ble: DeviceContext['ble'], secrets = createMemorySecretStore()): DeviceContext => ({
  clock: fixedClock,
  log: silentLogger,
  fetch: (() => Promise.reject(new Error('no fetch'))) as unknown as typeof fetch,
  ble,
  secrets,
});
const FAST = { rescanDelayMs: 5_000, responseTimeoutMs: 500, bondTimeoutMs: 500, adapterRetryMs: 20 };

describe('Dexcom G6 plugin', () => {
  it('has the expected meta and throws without BLE or with a bad ID', () => {
    expect(dexcomG6Cgm.meta).toMatchObject({ id: 'dexcom-g6', transport: 'ble', maturity: 'experimental' });
    expect(() => dexcomG6Cgm.create({ transmitterId: '8G1234', passiveMode: true }, ctxWith(undefined))).toThrow(/Bluetooth/);
    expect(() => dexcomG6Cgm.create({ transmitterId: 'abc', passiveMode: true }, ctxWith(createFakeBle().transport))).toThrow(/6 letters/);
  });

  it('active mode: authenticates, reads time + glucose, converts the timestamp', async () => {
    const fake = createFakeBle();
    const currentTime = 1_000_000;
    const sim = createG6Simulator({
      transmitterId: '8G1234',
      mode: 'active',
      currentTime,
      sessionStartTime: 500_000,
      glucose: { timestamp: currentTime - 30, glucose: 123, trend: -12 },
      expiryDays: 180,
    });
    fake.add(sim);
    const secrets = createMemorySecretStore();
    const src = createDexcomG6Source({ transmitterId: '8G1234', passiveMode: false }, ctxWith(fake.transport, secrets), { timing: FAST });
    await src.start();
    await vi.waitFor(async () => expect((await src.readings(0)).length).toBe(1), { timeout: 2000 });
    await src.stop();
    const [r] = await src.readings(0);
    expect(r).toEqual({ date: NOW - 30_000, value: 123, trend: 'fortyFiveDown', source: 'dexcom-g6' });
    expect(sim.authenticated).toBe(true);
    expect(sim.controlWrites).toEqual([0x24, 0x30, 0x32, 0x4a, 0x09]);
    expect(await src.readings(NOW - 30_000)).toEqual([]);
    const persisted = JSON.parse((await secrets.get(g6StateKey('8G1234')))!);
    expect(persisted).toEqual({ transmitterStartDate: NOW - currentTime * 1000, sensorStartOffset: 500_000, transmitterExpiryInDays: 180 });
  });

  it('active mode: a wrong transmitter ID fails authentication and yields no readings', async () => {
    const fake = createFakeBle();
    fake.add({ ...createG6Simulator({ transmitterId: '8G1234', mode: 'active', currentTime: 100, sessionStartTime: 0, glucose: { timestamp: 90, glucose: 100 } }), name: 'Dexcom34' });
    const errors: string[] = [];
    const ctx = { ...ctxWith(fake.transport), log: { ...silentLogger, error: (m: string) => void errors.push(m) } };
    const src = createDexcomG6Source({ transmitterId: '9X9934', passiveMode: false }, ctx, { timing: FAST });
    await src.start();
    await vi.waitFor(() => expect(errors.some((e) => /failed auth challenge/.test(e))).toBe(true), { timeout: 2000 });
    await src.stop();
    expect(await src.readings(0)).toEqual([]);
  });

  it('passive mode: follows the Dexcom app session including backfill', async () => {
    const fake = createFakeBle();
    const currentTime = 2_000_000;
    const backfill = [0, 1, 2].map((i) => ({ timestamp: currentTime - 930 + i * 300, glucose: 150 - i * 5, trend: -5 }));
    fake.add(
      createG6Simulator({
        transmitterId: '8G1234',
        mode: 'passive',
        currentTime,
        sessionStartTime: 1_500_000,
        glucose: { timestamp: currentTime - 30, glucose: 138, trend: 25 },
        backfill,
      }),
    );
    const src = createDexcomG6Source({ transmitterId: '8G1234', passiveMode: true }, ctxWith(fake.transport), { timing: FAST });
    await src.start();
    await vi.waitFor(async () => expect((await src.readings(0)).length).toBe(4), { timeout: 2000 });
    await src.stop();
    const rs = await src.readings(0);
    expect(rs.map((r) => [r.date, r.value])).toEqual([
      [NOW - 930_000, 150],
      [NOW - 630_000, 145],
      [NOW - 330_000, 140],
      [NOW - 30_000, 138],
    ]);
    expect(rs[3]!.trend).toBe('singleUp');
  });

  it('passive mode: drops unreliable readings (warm-up)', async () => {
    const fake = createFakeBle();
    fake.add(createG6Simulator({ transmitterId: '8G1234', mode: 'passive', currentTime: 5000, sessionStartTime: 4000, glucose: { timestamp: 4990, glucose: 120, state: CalibrationState.warmup } }));
    const src = createDexcomG6Source({ transmitterId: '8G1234', passiveMode: true }, ctxWith(fake.transport), { timing: FAST });
    await src.start();
    await new Promise((r) => setTimeout(r, 100));
    await src.stop();
    expect(await src.readings(0)).toEqual([]);
  });

  it('simulator glucose encoding round-trips through the parser', () => {
    const m = parseGlucoseRx(encodeGlucoseRx({ timestamp: 42, glucose: 99, trend: -3, displayOnly: true }))!;
    expect(m.glucose).toEqual({ timestamp: 42, glucose: 99, trend: -3, state: 6, glucoseIsDisplayOnly: true });
  });
});
