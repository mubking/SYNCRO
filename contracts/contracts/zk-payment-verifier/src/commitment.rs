use soroban_sdk::{Bytes, BytesN, Env};

/// Reconstruct commitment hash:
///   SHA-256("syncro:payment:v1" || user_id || service_id || amount_bytes || timestamp_bytes || blinding_factor)
pub fn compute_commitment(
    env: &Env,
    user_id: &Bytes,
    service_id: &Bytes,
    amount: u128,
    timestamp: u64,
    blinding_factor: &BytesN<32>,
) -> BytesN<32> {
    let mut payload = Bytes::from_slice(env, b"syncro:payment:v1");
    payload.append(&user_id.clone());
    payload.append(&service_id.clone());
    payload.append(&Bytes::from_slice(env, &amount.to_be_bytes()));
    payload.append(&Bytes::from_slice(env, &timestamp.to_be_bytes()));
    payload.append(&Bytes::from_slice(env, &blinding_factor.to_array()));

    env.crypto().sha256(&payload).into()
}

/// Compute nullifier: SHA-256("syncro:payment:v1" || blinding_factor || service_id)
/// Deterministic per (blinding_factor, service_id) pair — prevents double-proving.
pub fn compute_nullifier(
    env: &Env,
    blinding_factor: &BytesN<32>,
    service_id: &Bytes,
) -> BytesN<32> {
    let mut payload = Bytes::from_slice(env, b"syncro:payment:v1");
    payload.append(&Bytes::from_slice(env, &blinding_factor.to_array()));
    payload.append(&service_id.clone());

    env.crypto().sha256(&payload).into()
}
