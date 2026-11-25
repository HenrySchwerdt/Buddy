/**
 * TypeScript port of the test vectors `Libre2.Example`, `Libre2.Example2` and `Libre2.BLEExample`
 * in `LibreSensor/SensorContents/PreLibre2.swift` from loopandlearn/LibreTransmitter (MIT,
 * (c) the LibreTransmitter authors). Real encrypted Libre 2 FRAM dumps and a BLE packet; used by
 * the tests and handy for simulators. Hex strings (byte order as in Swift).
 */

export const LIBRE2_EXAMPLE = {
  sensorInfo: '9d0830017317',
  sensorId: '9d81c20000a407e0',
  buffer:
    '069add798e9af4baa2554f31eae0473abd797b271ca286f85f041ccb1b524c775262bdb79397200d499ed6a78f02b616' +
    '45bc49db079fb3a9ed4f20bd25d320a6bf96ab3c8f8f016959c562fa01c9153840bf3a11c66c486a90fd136febbbf5d0' +
    'ef3c91016b5eeec79d5df305049a1981834b10f0d276ac0e5031210b510beedc4e5552f5043f81fed6e9e1933a9914f7' +
    '0a2695230e3ba8e0a28d0948c95a388396597e0260268c4e97c439372514f9c7a83b29d9f043c75da479ce64d67e28e7' +
    '44044cca839a6250e3ed90357d850eaec45a4eeea3c7f94a4b387f3d62b499335544eacc759ef5b928bae33269e79ba0' +
    '42b27ca2467766a1ea69fcc8c3caf61247bd967b696a69df74a08e651c972acc312c6ff5a142b21a636e888c87a7aba0' +
    'dd7309e6694214c3acced7e26bfae0f106db8bfbbd6aa17c624ebaecc8371544ab39081bdd76ce5ee29b528f2cbaad56' +
    'f8de9e61f19cfdfe',
} as const;

export const LIBRE2_EXAMPLE2 = {
  sensorInfo: '9d0830017625',
  sensorId: 'df20be0000a407e0',
  buffer:
    '520bf344dca04321cc7dd74e29e282e3e704c9cf6c572c7da88210aad73219b3c79f395fe37a4508b709bc6efada3407' +
    'b46568607ea504e665654813f89ca7c870a74d9d523586f202cc9b9b7432ffc5bfe9781f46c2c70b0fb0c85423e20d44' +
    '9744368fac12ae4a6ce137e2462b5c741b7afe674fccdd951773b325e9aba65e70e46cce568db9e5feaa503652d2c522' +
    '2439d863086204adfa89001072cfa9f3474bf57096f28acaffefa39e1aec9f4a2fe8a9cae6c8744698b2a29e8df0af09' +
    'c15b52597e00d33f59417b33eedb4051b23d9482f3b2e4caad3cd8c0d7d74c51caa3ad2624ab10ba6135e17f3d3fecb4' +
    'cfe3a2316ae7d73618215b435a9c757c89e2496cb1716a476e8ae5b2c537e9e5ddb31237957ad01f73ebb815f1e65d51' +
    'fb1688a69c17b0400ebbd7ca9dcd8b60888854fc657143e751e218ea631d5baad1d3d708b7ed87c4b42431e7a0e65951' +
    '93fda3e6bfe1f209',
} as const;

export const LIBRE2_BLE_EXAMPLE = {
  sensorId: '2fe7b10000a407e0',
  data: 'b194faed2cdea1694657cfd0d85aaaf1e2891ce9ac8216fb67a1d3b63f91cd184b95316c045fe196c4fd14fc68e0',
} as const;
