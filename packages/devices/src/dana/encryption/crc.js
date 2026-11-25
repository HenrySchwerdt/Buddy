export function generateCrc(buffer, enhancedEncryption, isEncryptionCommand) {
    let crc = 0;
    for (const byte of buffer) {
        let result = (((crc >> 8) | (crc << 8)) & 0xffff) ^ byte;
        result ^= (result & 0xff) >> 4;
        result = (result ^ (result << 12)) & 0xffff;
        if (enhancedEncryption === 0) {
            const tmp = (((result & 0xff) << 3) | (((result & 0xff) >> 2) << 5)) & 0xffff;
            result ^= tmp;
        }
        else if (enhancedEncryption === 1) {
            let tmp = 0;
            if (isEncryptionCommand) {
                tmp = (((result & 0xff) << 3) | (((result & 0xff) >> 2) << 5)) & 0xffff;
            }
            else {
                tmp = (((result & 0xff) << 5) | (((result & 0xff) >> 4) << 2)) & 0xffff;
            }
            result ^= tmp;
        }
        else if (enhancedEncryption === 2) {
            let tmp = 0;
            if (isEncryptionCommand) {
                tmp = (((result & 0xff) << 3) | (((result & 0xff) >> 2) << 5)) & 0xffff;
            }
            else {
                tmp = (((result & 0xff) << 4) | (((result & 0xff) >> 3) << 2)) & 0xffff;
            }
            result ^= tmp;
        }
        crc = result & 0xffff;
    }
    return crc;
}
