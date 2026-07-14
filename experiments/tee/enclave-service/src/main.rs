// Veil TEE credential-issuance service (Nautilus-style spike).
//
// Boot: generate an ephemeral Ed25519 keypair (never exported, never
// persisted). In a real Nitro Enclave this key is committed inside the
// attestation document and registered on-chain via enclave::register_enclave.

use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use tokio::net::TcpListener;

use veil_tee_enclave::attestation::{get_attestation, health_check};
use veil_tee_enclave::issuance::issue_credential;
use veil_tee_enclave::{AppState, ISSUER_ID};

const DEFAULT_PORT: u16 = 3000;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let issuer_id = match std::env::var("VEIL_ISSUER_ID") {
        Ok(v) => v
            .parse::<u64>()
            .map_err(|e| format!("VEIL_ISSUER_ID must be a u64: {e}"))?,
        Err(_) => ISSUER_ID,
    };
    let port = match std::env::var("PORT") {
        Ok(v) => v
            .parse::<u16>()
            .map_err(|e| format!("PORT must be a u16: {e}"))?,
        Err(_) => DEFAULT_PORT,
    };

    // Ephemeral keypair: exists only in this process's memory.
    let eph_kp = SigningKey::generate(&mut OsRng);
    tracing::info!(
        pk = hex::encode(eph_kp.verifying_key().to_bytes()),
        issuer_id,
        "enclave service booted with fresh ephemeral key"
    );

    let state = Arc::new(AppState { eph_kp, issuer_id });
    let app = Router::new()
        .route("/health_check", get(health_check))
        .route("/get_attestation", get(get_attestation))
        .route("/issue_credential", post(issue_credential))
        .with_state(state);

    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on 0.0.0.0:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
