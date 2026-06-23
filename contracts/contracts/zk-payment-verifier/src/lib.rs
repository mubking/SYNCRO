#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Bytes, BytesN, Env, Map};

pub mod commitment;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Nullifiers,
}

#[contract]
pub struct ZkPaymentVerifier;

#[contractimpl]
impl ZkPaymentVerifier {
    /// Verify a payment commitment and record its nullifier.
    /// Returns true if the commitment is valid and the nullifier is fresh.
    pub fn verify_and_record(
        env: Env,
        user_id: Bytes,
        service_id: Bytes,
        amount: u128,
        timestamp: u64,
        blinding_factor: BytesN<32>,
        expected_commitment: BytesN<32>,
    ) -> bool {
        let computed = commitment::compute_commitment(
            &env,
            &user_id,
            &service_id,
            amount,
            timestamp,
            &blinding_factor,
        );

        if computed != expected_commitment {
            return false;
        }

        let nullifier = commitment::compute_nullifier(&env, &blinding_factor, &service_id);

        let mut nullifiers: Map<BytesN<32>, bool> = env
            .storage()
            .persistent()
            .get(&DataKey::Nullifiers)
            .unwrap_or(Map::new(&env));

        if nullifiers.contains_key(nullifier.clone()) {
            return false;
        }

        nullifiers.set(nullifier, true);
        env.storage()
            .persistent()
            .set(&DataKey::Nullifiers, &nullifiers);

        true
    }

    /// Check if a nullifier has already been used.
    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        let nullifiers: Map<BytesN<32>, bool> = env
            .storage()
            .persistent()
            .get(&DataKey::Nullifiers)
            .unwrap_or(Map::new(&env));

        nullifiers.contains_key(nullifier)
    }
}

#[cfg(test)]
mod test;
