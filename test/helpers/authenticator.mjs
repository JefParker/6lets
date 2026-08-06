// A synthetic P-256 authenticator, built from WebCrypto primitives.
//
// The whole passkey ceremony can be exercised without a physical key, and the
// hour it takes is worth it — the DER-to-raw signature bug in particular has no
// symptom at runtime (crypto.subtle.verify just returns false, forever, with a
// clean log), so a test is the only thing that will ever catch it.
//
// The steps mirror what a real authenticator does:
//   1. generate a P-256 keypair
//   2. export the public half as SPKI — exactly what getPublicKey() returns
//   3. build authData by hand: SHA-256(rpId) ‖ flags ‖ signCount
//   4. sign authData ‖ SHA-256(clientDataJSON)
//   5. re-wrap the signature as DER, because that is the shape a real
//      authenticator emits and WebCrypto's sign() does not
//
// Step 5 is the one that matters. WebCrypto hands back raw r‖s, so wrapping it
// back up into DER is what forces the server to unwrap it again. Delete
// derToRawEcdsaSignature from lib/webauthn.js and these tests go red; without
// step 5 they would pass either way and the trap would stay armed.

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAGS_UP_UV = FLAG_UP | FLAG_UV; // 0x05

const encoder = new TextEncoder();

function bytesToBase64url(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// raw r‖s (64 bytes) -> DER SEQUENCE { INTEGER r, INTEGER s }
//
// Mirror image of derToRawEcdsaSignature: strip nothing, but re-add the leading
// 0x00 whenever the top bit is set so the integer is not read as negative, and
// drop leading zero bytes that are not needed.
function rawSignatureToDer(raw) {
    const encodeInteger = (component) => {
        let start = 0;
        while (start < component.length - 1 && component[start] === 0x00) start++;
        let value = component.subarray(start);
        if (value[0] & 0x80) value = Uint8Array.from([0x00, ...value]);
        return Uint8Array.from([0x02, value.length, ...value]);
    };

    const r = encodeInteger(raw.subarray(0, 32));
    const s = encodeInteger(raw.subarray(32, 64));
    const body = Uint8Array.from([...r, ...s]);
    // A P-256 signature body never reaches 128 bytes, so the length is always
    // short-form here.
    return Uint8Array.from([0x30, body.length, ...body]);
}

export async function createAuthenticator(rpId) {
    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true, // extractable, so the public half can be exported as SPKI
        ['sign', 'verify']
    );

    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));

    async function buildAuthenticatorData({ flags = FLAGS_UP_UV, signCount = 0, rpIdOverride = null } = {}) {
        const rpIdHash = await sha256(encoder.encode(rpIdOverride ?? rpId));
        const authData = new Uint8Array(37);
        authData.set(rpIdHash, 0);
        authData[32] = flags;
        new DataView(authData.buffer).setUint32(33, signCount, false); // big-endian
        return authData;
    }

    function buildClientData({ type, challenge, origin, crossOrigin = false }) {
        return encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin }));
    }

    return {
        credentialId,
        publicKeySpki: spki,
        publicKeyBase64url: bytesToBase64url(spki),

        // Registration produces no signature at attestation: "none" — the
        // server checks the flags and the client data, and takes the key.
        async register({ challenge, origin, flags = FLAGS_UP_UV, rpIdOverride = null }) {
            return {
                credentialId,
                clientDataJSON: buildClientData({ type: 'webauthn.create', challenge, origin }),
                authenticatorData: await buildAuthenticatorData({ flags, rpIdOverride }),
                publicKeySpki: spki
            };
        },

        async sign({ challenge, origin, flags = FLAGS_UP_UV, signCount = 0, crossOrigin = false, rpIdOverride = null }) {
            const clientDataJSON = buildClientData({ type: 'webauthn.get', challenge, origin, crossOrigin });
            const authenticatorData = await buildAuthenticatorData({ flags, signCount, rpIdOverride });

            const clientDataHash = await sha256(clientDataJSON);
            const signedData = new Uint8Array(authenticatorData.length + clientDataHash.length);
            signedData.set(authenticatorData, 0);
            signedData.set(clientDataHash, authenticatorData.length);

            const rawSignature = new Uint8Array(await crypto.subtle.sign(
                { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData
            ));

            return {
                credentialId,
                clientDataJSON,
                authenticatorData,
                // DER, as a real authenticator would send it.
                signature: rawSignatureToDer(rawSignature),
                rawSignature,
                signedData
            };
        }
    };
}
