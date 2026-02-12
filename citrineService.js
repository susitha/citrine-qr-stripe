import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const BASE = process.env.CITRINE_URL;


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
Get ALL transactions
*/
export async function getTransactions() {
  const res = await fetch(`${BASE}/data/transactions`);
  const data = await res.json();

  return data.content || [];
}
