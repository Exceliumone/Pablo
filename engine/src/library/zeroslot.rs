use crate::error::ClientError;
use anyhow::{anyhow, Result};
use rand::{seq::IteratorRandom, thread_rng};
use serde_json::{json, Value};
use anchor_client::solana_sdk::{pubkey::Pubkey, signature::Signature, transaction::Transaction};
use std::{str::FromStr, sync::Arc};
use bs64;

pub fn get_tip_account() -> Result<Pubkey> {
    let accounts = [
        "6fQaVhYZA4w3MBSXjJ81Vf6W1EDYeUPXpgVQ6UQyU1Av".to_string(),
        "4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4".to_string(),
        "7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK".to_string(),
        "8mR3wB1nh4D6J9RUCugxUpc6ya8w38LPxZ3ZjcBhgzws".to_string(),
        "6SiVU5WEwqfFapRuYCndomztEwDjvS5xgtEof3PLEGm9".to_string(),
        "TpdxgNJBWZRL8UXF5mrEsyWxDWx9HQexA9P1eTWQ42p".to_string(),
        "D8f3WkQu6dCF33cZxuAsrKHrGsqGP2yvAHf8mX6RXnwf".to_string(),
        "GQPFicsy3P3NXxB5piJohoxACqTvWE9fKpLgdsMduoHE".to_string(),
        "Ey2JEr8hDkgN8qKJGrLf2yFjRhW7rab99HVxwi5rcvJE".to_string(),
        "4iUgjMT8q2hNZnLuhpqZ1QtiV8deFPy2ajvvjEpKKgsS".to_string(),
        "3Rz8uD83QsU8wKvZbgWAPvCNDU6Fy8TSZTMcPm3RB6zt".to_string(),
        "DiTmWENJsHQdawVUUKnUXkconcpW4Jv52TnMWhkncF6t".to_string(),
        "HRyRhQ86t3H4aAtgvHVpUJmw64BDrb61gRiKcdKUXs5c".to_string(),
        "7y4whZmw388w1ggjToDLSBLv47drw5SUXcLk6jtmwixd".to_string(),
        "J9BMEWFbCBEjtQ1fG5Lo9kouX1HfrKQxeUxetwXrifBw".to_string(),
        "8U1JPQh3mVQ4F5jwRdFTBzvNRQaYFQppHQYoH38DJGSQ".to_string(),
        "Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3".to_string(),
        "FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe".to_string(),
        "ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13".to_string(),
        "6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK".to_string(),
        "Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr".to_string(),
    ];
    let mut rng = thread_rng();
    let tip_account = match accounts.iter().choose(&mut rng) {
        Some(acc) => Ok(Pubkey::from_str(acc).inspect_err(|err| {
            println!("zeroslot: failed to parse Pubkey: {:?}", err);
        })?),
        None => Err(anyhow!("zeroslot: no tip accounts available")),
    };

    let tip_account = tip_account?;
    Ok(tip_account)
}

pub async fn get_tip_value() -> Result<f64> {
    // If ZERO_SLOT_TIP_VALUE is set, use it
    if let Ok(tip_value) = std::env::var("ZERO_SLOT_TIP_VALUE") {
        match f64::from_str(&tip_value) {
            Ok(value) => Ok(value),
            Err(_) => {
                println!(
                    "Invalid ZERO_SLOT_TIP_VALUE in environment variable: '{}'. Falling back to percentile calculation.",
                    tip_value
                );
                Err(anyhow!("Invalid TIP_VALUE in environment variable"))
            }
        }
    } else {
        Err(anyhow!("ZERO_SLOT_TIP_VALUE environment variable not set"))
    }
}

pub const MAX_RETRIES: u8 = 3;

#[derive(Debug, Clone)]
pub struct TransactionConfig {
    pub skip_preflight: bool,
    pub encoding: String,
}

impl Default for TransactionConfig {
    fn default() -> Self {
        Self {
            skip_preflight: true,
            encoding: "base64".to_string(),
        }
    }
}

#[derive(Clone)]
pub struct ZeroSlotClient {
    /// `None` means ZeroSlot has no configuration (`ZERO_SLOT_URL` unset or
    /// empty) — by explicit product decision, PABLO must be able to run
    /// entirely on the free public RPC until the operator opts in to a paid
    /// landing service later. `is_configured()` reports this so callers
    /// (see `block_engine::tx::new_signed_and_send_zeroslot`) skip the
    /// ZeroSlot-specific tip instruction and any `ZERO_SLOT_*` env var reads
    /// entirely and send over `fallback_rpc_client` instead, rather than
    /// erroring out asking for configuration that was never provided.
    endpoint: Option<String>,
    client: reqwest::Client,
    config: TransactionConfig,
    fallback_rpc_client: Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>,
}

impl std::fmt::Debug for ZeroSlotClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZeroSlotClient")
            .field("endpoint", &self.endpoint)
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl ZeroSlotClient {
    pub fn new(
        endpoint: Option<&str>,
        fallback_rpc_client: Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient>,
    ) -> Self {
        Self {
            endpoint: endpoint.map(|e| e.to_string()),
            client: reqwest::Client::new(),
            config: TransactionConfig::default(),
            fallback_rpc_client,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.endpoint.is_some()
    }

    /// The plain public-RPC client to send through when ZeroSlot isn't
    /// configured — the same nonblocking RPC client the rest of this
    /// process already uses, not a second connection.
    pub fn fallback_rpc_client(
        &self,
    ) -> Arc<anchor_client::solana_client::nonblocking::rpc_client::RpcClient> {
        self.fallback_rpc_client.clone()
    }

    pub async fn send_transaction(
        &self,
        transaction: &Transaction,
    ) -> Result<Signature, ClientError> {
        let wire_transaction = bincode::serialize(transaction).map_err(|e| {
            ClientError::Parse(
                "Transaction serialization failed".to_string(),
                e.to_string(),
            )
        })?;

        let encoded_tx = &bs64::encode(&wire_transaction);

        for retry in 0..MAX_RETRIES {
            match self.try_send_transaction(encoded_tx).await {
                Ok(signature) => {
                    return Signature::from_str(&signature).map_err(|e| {
                        ClientError::Parse("Invalid signature".to_string(), e.to_string())
                    });
                }
                Err(e) => {
                    println!("Retry {} failed: {:?}", retry, e);
                    if retry == MAX_RETRIES - 1 {
                        return Err(e);
                    }
                    // tokio::time::sleep(RETRY_DELAY).await;
                }
            }
        }

        Err(ClientError::Other("Max retries exceeded".to_string()))
    }

    async fn try_send_transaction(&self, encoded_tx: &str) -> Result<String, ClientError> {
        let params = json!([
            encoded_tx,
            {
                "skipPreflight": self.config.skip_preflight,
                "encoding": self.config.encoding,
            }
        ]);

        let response = self.send_request("sendTransaction", params).await?;

        response["result"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| {
                ClientError::Parse(
                    "Invalid response format".to_string(),
                    "Missing result field".to_string(),
                )
            })
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, ClientError> {
        let endpoint = self.endpoint.as_deref().ok_or_else(|| {
            ClientError::Other(
                "ZeroSlot is not configured (ZERO_SLOT_URL unset) — caller should have used \
                 fallback_rpc_client()/is_configured() instead of reaching send_transaction()"
                    .to_string(),
            )
        })?;
        let request_body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        });

        let response = self
            .client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| ClientError::Solana("Request failed".to_string(), e.to_string()))?;

        let response_data: Value = response
            .json()
            .await
            .map_err(|e| ClientError::Parse("Invalid JSON response".to_string(), e.to_string()))?;

        if let Some(error) = response_data.get("error") {
            return Err(ClientError::Solana(
                "RPC error".to_string(),
                error.to_string(),
            ));
        }

        Ok(response_data)
    }
}
