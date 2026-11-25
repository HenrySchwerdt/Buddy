import { concatBytes } from '@buddy/core';
import { crc8 } from './crc8';
import { leUint } from './bytes';
const MAX_CHUNK = 15;
export class MedtrumBasePacket {
    // Needed to parse
    dataSize = 0;
    responseCode = 0;
    totalData = new Uint8Array(0);
    sequenceNumber = 0;
    failed = false;
    encode(sequenceNumber) {
        const content = this.getRequestBytes();
        const header = new Uint8Array([content.length + 5, this.commandType, sequenceNumber & 0xff, 0 /* pkgIndex */]);
        const tmp = concatBytes(header, content);
        const totalCommand = concatBytes(tmp, new Uint8Array([crc8(tmp)]));
        if (totalCommand.length - header.length <= MAX_CHUNK) {
            return [concatBytes(totalCommand, new Uint8Array([0]))];
        }
        // We need to split up the command in multiple packages
        const packages = [];
        let pkgIndex = 1;
        let remaining = totalCommand.subarray(4);
        while (remaining.length > MAX_CHUNK) {
            header[3] = pkgIndex;
            const tmp2 = concatBytes(header, remaining.subarray(0, MAX_CHUNK));
            packages.push(concatBytes(tmp2, new Uint8Array([crc8(tmp2)])));
            remaining = remaining.subarray(MAX_CHUNK);
            pkgIndex = (pkgIndex + 1) & 0xff;
        }
        header[3] = pkgIndex;
        const tmp3 = concatBytes(header, remaining);
        packages.push(concatBytes(tmp3, new Uint8Array([crc8(tmp3)])));
        return packages;
    }
    decode(data) {
        if (this.totalData.length === 0) {
            // header 6 bytes + CRC byte
            if (data.length < 7) {
                this.failed = true;
                return;
            }
            if (data[1] !== this.commandType) {
                this.failed = true;
            }
            this.totalData = data.slice(0, data.length - 1);
            this.dataSize = data[0];
            this.sequenceNumber = data[3];
            this.responseCode = leUint(data, 4, 2);
            if (crc8(data.subarray(0, data.length - 1)) !== data[data.length - 1]) {
                this.failed = true;
            }
            return;
        }
        // fragment header (4 bytes) + CRC byte
        if (data.length < 5) {
            this.failed = true;
            return;
        }
        this.totalData = concatBytes(this.totalData, data.subarray(4, data.length - 1));
        this.sequenceNumber = (this.sequenceNumber + 1) & 0xff;
        if (crc8(data.subarray(0, data.length - 1)) !== data[data.length - 1]) {
            this.failed = true;
        }
        if (this.sequenceNumber !== data[3]) {
            this.failed = true;
        }
    }
    /** Forget a partially decoded response (used when the pump answers "busy", see link.ts). */
    resetDecoder() {
        this.dataSize = 0;
        this.responseCode = 0;
        this.totalData = new Uint8Array(0);
        this.sequenceNumber = 0;
        this.failed = false;
    }
    get isComplete() {
        return this.totalData.length === this.dataSize;
    }
    get hasEnoughData() {
        return this.totalData.length >= this.minimumDataSize;
    }
}
