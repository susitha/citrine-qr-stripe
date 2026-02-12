import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const BASE = process.env.CITRINE_SERVER;
const HASURA_URL = "http://localhost:8090/v1/graphql"; // Internal Hasura URL

/*
Remote Start
*/
export async function remoteStart(chargerId) {
  const url =
    `${BASE}/ocpp/1.6/evdriver/remoteStartTransaction` +
    `?identifier=${chargerId}&tenantId=1`;

  const res = await fetch(url, { method: "POST" });

  return res.json();
}


/*
Remote Stop
*/
export async function remoteStop(transactionId) {
  const url =
    `${BASE}/ocpp/1.6/evdriver/remoteStopTransaction` +
    `?transactionId=${transactionId}&tenantId=1`;

  await fetch(url, { method: "POST" });
}


/*
Get ALL transactions (GraphQL)
*/
export async function getTransactions() {
  try {
    const query = `
      query {
        Transactions {
          id
          stationId
          isActive
          transactionId
          startTime
        }
      }
    `;

    const res = await fetch(HASURA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    return data.data?.Transactions || [];
  } catch (err) {
    console.error("Error fetching transactions (GraphQL):", err.message);
    return [];
  }
}
