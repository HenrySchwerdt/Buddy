/**
 * TypeScript port of DanaKit/PumpManager/PeripheralManager.swift (and the UUIDs of
 * Common/CBUUID.swift) from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit
 * authors).
 *
 * One instance per BLE connection: it runs the encryption handshake, frames/encrypts commands,
 * reassembles and decrypts notifications, and hands back the response of the single command in
 * flight. CoreBluetooth delegate callbacks become a `BleConnection` subscription; the dispatch
 * group + timeout of `writeMessage` becomes a promise with a timer.
 */
import { hex } from '@buddy/core';
import { DanaKitEncryption } from './encryption';
import { DanaPacketType, EncryptionType, OpCodeIndex } from './packet-type';
import { HistoryCode } from './packets/history';
export const DANA_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
export const DANA_READ_CHAR = '0000fff1-0000-1000-8000-00805f9b34fb';
export const DANA_WRITE_CHAR = '0000fff2-0000-1000-8000-00805f9b34fb';
/** Largest chunk DanaKit writes (BLE 4 default MTU − 3). */
export const DANA_CHUNK_SIZE = 20;
/** `TimeInterval.seconds(4)` */
export const COMMAND_TIMEOUT_MS = 4_000;
/** `TimeInterval.seconds(21)` — see `isHistoryPacket` below. */
export const HISTORY_TIMEOUT_MS = 21_000;
/** A partially received message older than this belongs to an abandoned command. */
const STALE_READ_BUFFER_MS = 2_000;
export const usingUtc = (s) => s.hwModel >= 7;
const okCharCodes = [0x4f, 0x4b]; // O, K
const pumpCharCodes = [0x50, 0x55, 0x4d, 0x50]; // P, U, M, P
const busyCharCodes = [0x42, 0x55, 0x53, 0x59]; // B, U, S, Y
const PACKET_START_BYTE = 0xa5;
const PACKET_END_BYTE = 0x5a;
const ENCRYPTED_START_BYTE = 0xaa;
const ENCRYPTED_END_BYTE = 0xee;
const noop = () => { };
const isZeroFree = (b) => b.length > 0 && !b.some((x) => x === 0);
const isAllZeroOrEmpty = (b) => !b.some((x) => x !== 0);
/**
 * Intended `isHistoryPacket`: REVIEW history opcodes and the APS history. DanaKit compares
 * `(0xB2 << 8) + opCode` against the raw opcodes, so its check is always false and history
 * uploads get the 4 s timeout; the intended 21 s is used here (deviation, documented).
 */
const isHistoryOpCode = (op) => (op >= DanaPacketType.OPCODE_REVIEW__BOLUS && op <= DanaPacketType.OPCODE_REVIEW__ALL_HISTORY) || op === DanaPacketType.OPCODE__APS_HISTORY_EVENTS;
export class DanaPeripheral {
    conn;
    state;
    hooks;
    encryptor = new DanaKitEncryption();
    readBuffer = [];
    readBufferUpdatedAt = null;
    pending = null;
    // Handshake state. Scoped to this connection, since a PeripheralManager is created per connection
    pumpCheckSent = false;
    encryptionModeSet = false;
    isConnectionFinished = false;
    closed = false;
    unsubscribe = null;
    constructor(conn, state, hooks) {
        this.conn = conn;
        this.state = state;
        this.hooks = hooks;
        this.encryptor.setEnhancedEncryption(state.encryptionMode);
    }
    get deviceName() {
        return this.state.deviceName;
    }
    /** Enables notifications and sends the first handshake message (`didUpdateNotificationStateFor`). */
    async start() {
        this.unsubscribe = await this.conn.subscribe(DANA_SERVICE, DANA_READ_CHAR, (data) => this.parseReceivedValue(data));
        this.hooks.log.info('Dana: notifications enabled. Sending starting handshake');
        await this.sendFirstMessageEncryption();
    }
    /** Fails the command in flight; called when the link dropped. */
    close(error) {
        if (this.closed)
            return;
        this.closed = true;
        this.unsubscribe?.();
        const p = this.pending;
        this.pending = null;
        if (p) {
            clearTimeout(p.timer);
            p.reject(error);
        }
    }
    writeMessage(packet, timeoutMs) {
        return this.write(packet, timeoutMs);
    }
    /** History packets: resolves with every record once the pump sent the "done" marker. */
    writeHistory(packet, timeoutMs) {
        return this.write(packet, timeoutMs);
    }
    async write(packet, timeoutMs) {
        if (this.closed)
            throw new Error('No connected device');
        if (this.pending)
            throw new Error('A command is already running');
        const packetData = packet.generate();
        const timeout = timeoutMs ?? (isHistoryOpCode(packet.opCode) ? HISTORY_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
        const response = new Promise((resolve, reject) => {
            // Get rid of the leftovers of a command which has timed out. Without this, a half received
            // message would block the read buffer for the remainder of this connection, since every
            // following message would be appended to it, and the items of an aborted history upload
            // would be reported a second time
            this.discardStaleReadBuffer();
            const timer = setTimeout(() => {
                if (this.pending?.timer === timer)
                    this.pending = null;
                reject(new Error('Timeout has been hit...'));
            }, timeout);
            this.pending = { packet, resolve, reject, timer, historyLog: [] };
        });
        // The caller only awaits `response` after the writes; never let an early rejection go unhandled
        response.catch(() => { });
        // Make sure we have the correct state
        this.state.isInFetchHistoryMode = packet.opCode === DanaPacketType.OPCODE_REVIEW__SET_HISTORY_UPLOAD_MODE && packetData[0] === 0x01;
        let data = this.encryptor.encodePacket(packet.opCode, packetData, this.deviceName);
        this.hooks.log.info(`Dana: sending ${packet.name} (0x${packet.opCode.toString(16)}) ${hex(data)}`);
        if (this.encryptor.shouldDoSecondLevel()) {
            data = this.encryptor.encodeSecondLevel(data);
        }
        try {
            // A write that never settles must not outlive the command timeout (it would block the queue)
            await Promise.race([this.writeChunks(data), response.then(noop, noop)]);
        }
        catch (e) {
            // (read through a method: TypeScript keeps `this.pending` narrowed to null across the await)
            const p = this.inFlight();
            if (p) {
                clearTimeout(p.timer);
                this.pending = null;
                p.reject(e instanceof Error ? e : new Error(String(e)));
            }
        }
        return response;
    }
    inFlight() {
        return this.pending;
    }
    async writeChunks(data) {
        for (let start = 0; start < data.length; start += DANA_CHUNK_SIZE) {
            if (this.closed)
                throw new Error('No write characteristic available. Device might be disconnected...');
            await this.conn.write(DANA_SERVICE, DANA_WRITE_CHAR, data.slice(start, start + DANA_CHUNK_SIZE), false);
        }
    }
    discardStaleReadBuffer() {
        if (this.readBuffer.length === 0)
            return;
        // The chunks of a single message arrive within milliseconds of each other. Anything older
        // belongs to a command which has been given up on
        if (this.readBufferUpdatedAt !== null && Date.now() - this.readBufferUpdatedAt < STALE_READ_BUFFER_MS)
            return;
        this.hooks.log.warn(`Dana: discarding ${this.readBuffer.length} bytes of a message which was never completed`);
        this.clearReadBuffer();
    }
    connectionFailure(error) {
        void this.conn.disconnect().catch(() => { });
        this.hooks.onConnectionResult({ kind: 'failure', error });
    }
    writeValue(data) {
        this.writeChunks(data).catch((e) => this.connectionFailure(e instanceof Error ? e : new Error(String(e))));
    }
    // MARK: - Encryption/Connection functions
    async sendFirstMessageEncryption() {
        if (this.pumpCheckSent) {
            this.hooks.log.warn('Dana: PUMP_CHECK has already been sent for this connection. Ignoring duplicate call');
            return;
        }
        this.pumpCheckSent = true;
        const data = this.encryptor.encodePacket(DanaPacketType.OPCODE_ENCRYPTION__PUMP_CHECK, null, this.deviceName);
        this.hooks.log.info(`Dana: sending initial encryption request ${hex(data)}`);
        await this.writeChunks(data);
    }
    sendTimeInfo() {
        const data = this.encryptor.encodePacket(DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION, null, this.deviceName);
        this.writeValue(data);
    }
    sendV3PairingInformation(requestNewPairing) {
        const data = this.encryptor.encodePacket(DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION, new Uint8Array([requestNewPairing]), this.deviceName);
        this.writeValue(data);
    }
    // 0x00 Start encryption, 0x01 Request pairing
    sendV3PairingInformationEmpty() {
        let [pairingKey, randomPairingKey] = this.encryptor.getPairingKeys();
        if (isAllZeroOrEmpty(pairingKey) || isAllZeroOrEmpty(randomPairingKey)) {
            pairingKey = this.state.pairingKey;
            randomPairingKey = this.state.randomPairingKey;
            if (isAllZeroOrEmpty(pairingKey) || isAllZeroOrEmpty(randomPairingKey)) {
                this.sendV3PairingInformation(1);
                return;
            }
        }
        this.hooks.log.info('Dana: setting stored RSv3 encryption keys');
        this.encryptor.setPairingKeys(pairingKey, randomPairingKey, this.state.randomSyncKey);
        this.sendV3PairingInformation(0);
    }
    sendEasyMenuCheck() {
        const data = this.encryptor.encodePacket(DanaPacketType.OPCODE_ENCRYPTION__GET_EASYMENU_CHECK, null, this.deviceName);
        this.writeValue(data);
    }
    sendBLE5PairingInformation() {
        const data = this.encryptor.encodePacket(DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION, new Uint8Array([0, 0, 0, 0]), this.deviceName);
        this.writeValue(data);
    }
    /** Used after entering PIN codes (only for DanaRS v3) */
    finishV3Pairing(pairingKey, randomPairingKey) {
        this.hooks.log.info('Dana: storing RSv3 security keys');
        this.encryptor.setPairingKeys(pairingKey, randomPairingKey, null);
        this.state.pairingKey = pairingKey.slice();
        this.state.randomPairingKey = randomPairingKey.slice();
        this.hooks.onKeysChanged();
        this.sendV3PairingInformation(0);
    }
    processEasyMenuCheck() {
        if (this.encryptor.isDanaRS()) {
            this.sendV3PairingInformationEmpty();
        }
        else {
            this.sendTimeInfo();
        }
    }
    processConnectResponse(data) {
        if (this.encryptionModeSet) {
            // The pump can answer PUMP_CHECK a second time (often with an empty payload) after the handshake moved on.
            // Failing the connection here would tear down a session which is doing just fine
            this.hooks.log.warn(`Dana: ignoring duplicate PUMP_CHECK response ${hex(data)}`);
            return;
        }
        if (data.length === 4 && this.isOk(data)) {
            // response OK v1. DanaKit continues with a passkey request, but its DEFAULT-mode flow
            // cannot complete: setPairingKeys() traps on the 2-byte key and the password check always
            // fails (`UInt8 << 8` is 0 in Swift). Buddy refuses these pumps up front.
            this.connectionFailure(new Error('Dana RS with legacy (v1/DEFAULT) encryption is not supported by this driver'));
        }
        else if (data.length === 9 && this.isOk(data)) {
            // response OK v3, 2nd layer encryption
            this.hooks.log.info('Dana: setting encryption mode to RSv3');
            this.encryptor.setEnhancedEncryption(EncryptionType.RSv3);
            this.encryptionModeSet = true;
            this.state.encryptionMode = EncryptionType.RSv3;
            this.state.ignorePassword = true;
            this.state.hwModel = data[5];
            this.state.pumpProtocol = data[7];
            // Grab syncKey
            this.state.randomSyncKey = data[data.length - 1];
            if (this.state.hwModel === 0x05) {
                this.sendV3PairingInformationEmpty();
            }
            else if (this.state.hwModel === 0x06) {
                this.sendEasyMenuCheck();
            }
            else {
                this.connectionFailure(new Error(`Invalid hwModel ${this.state.hwModel}`));
            }
        }
        else if (data.length === 14 && this.isOk(data)) {
            this.hooks.log.info('Dana: setting encryption mode to BLE5');
            this.encryptor.setEnhancedEncryption(EncryptionType.BLE_5);
            this.encryptionModeSet = true;
            this.state.encryptionMode = EncryptionType.BLE_5;
            this.state.hwModel = data[5];
            this.state.pumpProtocol = data[7];
            if (this.state.hwModel !== 0x09 && this.state.hwModel !== 0x0a) {
                this.connectionFailure(new Error(`Invalid hwModel ${this.state.hwModel}`));
                return;
            }
            let ble5Keys = data.slice(8, 14);
            if (ble5Keys.some((b) => b === 0)) {
                // Try to get keys from previous session
                ble5Keys = this.state.ble5Keys.slice();
            }
            if (!isZeroFree(ble5Keys) || !this.encryptor.setBle5Key(ble5Keys)) {
                this.hooks.log.error('Dana: invalid BLE-5 keys. Please unbond the device and try again.');
                void this.conn.disconnect().catch(() => { });
                this.hooks.onConnectionResult({ kind: 'invalidBle5Keys' });
                return;
            }
            this.state.ble5Keys = ble5Keys;
            this.hooks.onKeysChanged();
            this.sendBLE5PairingInformation();
        }
        else if (data.length === 6 && this.isPump(data)) {
            this.connectionFailure(new Error('PUMP_CHECK error'));
        }
        else if (data.length === 6 && this.isBusy(data)) {
            this.connectionFailure(new Error('PUMP_CHECK_BUSY error'));
        }
        else {
            this.connectionFailure(new Error('PUMP_CHECK error, wrong serial number'));
        }
    }
    processEncryptionResponse(data) {
        if (this.encryptor.isDanaI()) {
            this.finishConnection();
        }
        else if (this.encryptor.isDanaRS()) {
            // data[2] : 0x00 OK  0x01 Error, No pairing
            if (data[2] === 0x00) {
                const [pairingKey, randomPairingKey] = this.encryptor.getPairingKeys();
                if (pairingKey.length === 0 || randomPairingKey.length === 0) {
                    this.hooks.log.info('Dana: device is requesting pincode');
                    this.hooks.onConnectionResult({ kind: 'requestedPincode', message: null });
                    return;
                }
                this.finishConnection();
            }
            else {
                this.sendV3PairingInformation(1);
            }
        }
        else {
            // DEFAULT mode is refused in processConnectResponse
            this.connectionFailure(new Error('Unexpected TIME_INFORMATION response in DEFAULT mode'));
        }
    }
    finishConnection() {
        this.isConnectionFinished = true;
        this.state.isConnected = true;
        this.hooks.log.info('Dana: connection and encryption successful!');
        this.hooks.onConnectionResult({ kind: 'success' });
    }
    isOk(data) {
        return data[2] === okCharCodes[0] && data[3] === okCharCodes[1];
    }
    isPump(data) {
        return pumpCharCodes.every((c, i) => data[2 + i] === c);
    }
    isBusy(data) {
        return busyCharCodes.every((c, i) => data[2 + i] === c);
    }
    // MARK: Parsers for incoming messages
    parseReceivedValue(received) {
        let data = received;
        if (data.length > 0 && this.state.isConnected && this.encryptor.shouldDoSecondLevel()) {
            data = this.encryptor.decodeSecondLevel(data);
        }
        const result = this.appendToReadBuffer(data);
        if (result.kind === 'incomplete')
            return;
        if (result.kind === 'unrecoverable') {
            void this.conn.disconnect().catch(() => { });
            return;
        }
        const decryptedData = this.encryptor.decodePacket(result.message, this.deviceName);
        if (decryptedData.length < 2) {
            this.hooks.log.error('Dana: decryption failed...');
            return;
        }
        switch (decryptedData[0]) {
            case DanaPacketType.TYPE_ENCRYPTION_RESPONSE:
                this.processConnectHandshake(decryptedData);
                return;
            case DanaPacketType.TYPE_NOTIFY:
                this.processNotify(decryptedData);
                return;
            case DanaPacketType.TYPE_RESPONSE:
                this.processMessage(decryptedData);
                return;
            default:
                this.hooks.log.error(`Dana: received invalid packet type ${decryptedData[0]}`);
        }
    }
    /** Adds the received chunk to the read buffer and hands back the raw message once it is complete */
    appendToReadBuffer(data) {
        for (const b of data)
            this.readBuffer.push(b);
        this.readBufferUpdatedAt = Date.now();
        if (this.readBuffer.length < 6) {
            // Buffer is not ready to be processed
            return { kind: 'incomplete' };
        }
        const startOk = (b) => b === PACKET_START_BYTE || b === ENCRYPTED_START_BYTE;
        if (!startOk(this.readBuffer[0]) || !startOk(this.readBuffer[1])) {
            // The buffer does not start with the opening bytes. Check if the buffer is filled with old data
            const indexStartByte = this.readBuffer.indexOf(PACKET_START_BYTE);
            const indexEncryptedStartByte = this.readBuffer.indexOf(ENCRYPTED_START_BYTE);
            if (indexStartByte >= 0) {
                this.readBuffer = this.readBuffer.slice(indexStartByte);
            }
            else if (indexEncryptedStartByte >= 0) {
                this.readBuffer = this.readBuffer.slice(indexEncryptedStartByte);
            }
            else {
                this.hooks.log.error('Dana: received invalid packets. Starting bytes do not exist in message. Encryption mode possibly wrong');
                this.clearReadBuffer();
                return { kind: 'unrecoverable' };
            }
        }
        const length = this.readBuffer[2] ?? 0;
        if (length + 7 !== this.readBuffer.length) {
            if (this.readBuffer.length >= length + 7) {
                // The buffer can never complete anymore. Get rid of it, otherwise every following
                // message would be appended to it and this connection would never receive anything again
                this.hooks.log.error(`Dana: read buffer got out of sync. Should be: ${length + 7}, currently: ${this.readBuffer.length}`);
                this.clearReadBuffer();
            }
            // Not all packets have been received yet...
            return { kind: 'incomplete' };
        }
        const endOk = (b) => b === PACKET_END_BYTE || b === ENCRYPTED_END_BYTE;
        if (!endOk(this.readBuffer[length + 5]) || !endOk(this.readBuffer[length + 6])) {
            // Invalid packets received...
            this.hooks.log.error('Dana: received invalid packets. Ending bytes do not match.');
            this.clearReadBuffer();
            return { kind: 'incomplete' };
        }
        const rawMessage = new Uint8Array(this.readBuffer);
        this.clearReadBuffer();
        return { kind: 'message', message: rawMessage };
    }
    clearReadBuffer() {
        this.readBuffer = [];
        this.readBufferUpdatedAt = null;
    }
    processMessage(data) {
        const pending = this.pending;
        if (!pending || data[OpCodeIndex] !== pending.packet.opCode) {
            this.hooks.log.error('Dana: no stream found to send this message back...');
            return;
        }
        const message = pending.packet.parse(data, usingUtc(this.state));
        if (pending.packet.isHistory) {
            const historyItem = message.data;
            if (historyItem && historyItem.code !== HistoryCode.RECORD_TYPE_DONE_UPLOAD) {
                pending.historyLog.push(historyItem);
                return;
            }
            this.release(pending);
            // DanaKit reports the collected upload as `success: true` regardless of the done marker's status byte
            pending.resolve({ success: true, rawData: new Uint8Array(0), data: pending.historyLog.slice() });
            return;
        }
        this.release(pending);
        pending.resolve(message);
    }
    release(p) {
        clearTimeout(p.timer);
        if (this.pending === p)
            this.pending = null;
    }
    processNotify(data) {
        switch (data[OpCodeIndex]) {
            case DanaPacketType.OPCODE_NOTIFY__DELIVERY_COMPLETE:
                this.hooks.onNotification({ kind: 'deliveryComplete', data });
                return;
            case DanaPacketType.OPCODE_NOTIFY__DELIVERY_RATE_DISPLAY:
                this.hooks.onNotification({ kind: 'deliveryRateDisplay', data });
                return;
            case DanaPacketType.OPCODE_NOTIFY__ALARM:
                this.hooks.onNotification({ kind: 'alarm', data });
                return;
            case DanaPacketType.OPCODE_NOTIFY__MISSED_BOLUS_ALARM:
                this.hooks.onNotification({ kind: 'missedBolus', data });
                return;
            default:
                return;
        }
    }
    processConnectHandshake(data) {
        if (this.isConnectionFinished) {
            this.hooks.log.warn(`Dana: ignoring encryption packet received after connection was established ${hex(data)}`);
            return;
        }
        switch (data[1]) {
            case DanaPacketType.OPCODE_ENCRYPTION__PUMP_CHECK:
                this.processConnectResponse(data);
                return;
            case DanaPacketType.OPCODE_ENCRYPTION__TIME_INFORMATION:
                this.processEncryptionResponse(data);
                return;
            case DanaPacketType.OPCODE_ENCRYPTION__GET_PUMP_CHECK:
                if (data[2] === 0x05) {
                    this.sendTimeInfo();
                }
                else {
                    this.sendEasyMenuCheck();
                }
                return;
            case DanaPacketType.OPCODE_ENCRYPTION__GET_EASYMENU_CHECK:
                this.processEasyMenuCheck();
                return;
            default:
                // CHECK_PASSKEY / PASSKEY_REQUEST / PASSKEY_RETURN only occur in the refused DEFAULT mode
                this.hooks.log.error(`Dana: received unsupported encryption command type ${data[1]}`);
                return;
        }
    }
}
