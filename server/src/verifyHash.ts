import { createHmac, timingSafeEqual } from "crypto"

export function verifyHash(payload: any, signature: string, secret: string) {
    const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

}