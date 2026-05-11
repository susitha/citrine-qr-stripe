import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const BASE = process.env.CITRINE_SERVER;
const HASURA_URL = "http://localhost:8090/v1/graphql"; // Internal Hasura URL

/*
Remote Start
*/
export async function remoteStart(chargerId, idTag = "DRIVER_001") {
  const url =
    `${BASE}/ocpp/1.6/evdriver/remoteStartTransaction` +
    `?identifier=${chargerId}&tenantId=1`;

  console.log(`[Citrine] Requesting Remote Start: Charger=${chargerId}, idTag=${idTag}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CITRINE_API_KEY}`,
    },
    body: JSON.stringify({
      idTag: idTag
    }),
  });

  const data = await res.json();

  // 1. Handle OCPP CallError: Citrine returns { _errorCode, _messageId }
  if (data?._errorCode) {
    console.error(`[Citrine] RemoteStart OCPP error for ${chargerId}: ${data._errorCode}`);
    throw new Error(`OCPP_ERROR:${data._errorCode}`);
  }

  // 2. Handle failure responses in list format (e.g. [ { success: false, payload: '...' } ])
  // This happens when the charger is fundamentally disconnected or unknown.
  if (Array.isArray(data) && data[0]?.success === false) {
    console.error(`[Citrine] RemoteStart failed for ${chargerId}: ${data[0].payload}`);
    throw new Error(`OCPP_ERROR:FAILED_${data[0].payload || 'UNKNOWN'}`);
  }

  return data;
}


/*
Remote Stop
*/
export async function remoteStop(stationId, transactionId) {
  const url =
    `${BASE}/ocpp/1.6/evdriver/remoteStopTransaction` +
    `?identifier=${stationId}&tenantId=1`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CITRINE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transactionId: parseInt(transactionId),
    }),
  });
}


/*
Get ALL transactions (GraphQL)
*/
export async function getTransactions() {
  try {
    const query = `
      query {
        Transactions(limit: 100, order_by: {startTime: desc}) {
          id
          transactionId
          stationId
          isActive
          startTime
          endTime
          totalKwh
          totalCost
        }
      }
    `;

    const res = await fetch(HASURA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.CITRINE_API_KEY}`
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    //console.log("[Citrine] GraphQL Response:", JSON.stringify(data, null, 2));

    return data.data?.Transactions || [];
  } catch (err) {
    console.error("Error fetching transactions (GraphQL):", err.message);
    return [];
  }
}

/**
 * Register a new ID Tag in CitrineOS via GraphQL
 */
export async function registerIdTag(idTag, type = "Central", tenantId = 1) {
  const mutation = `
    mutation($object: Authorizations_insert_input!) {
      insert_Authorizations_one(object: $object) {
        idToken
        status
      }
    }
  `;

  const now = new Date().toISOString();
  const variables = {
    object: {
      idToken: idTag,
      idTokenType: type,
      tenantId: tenantId,
      status: "Accepted",
      createdAt: now,
      updatedAt: now
    }
  };

  try {
    const res = await fetch(HASURA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.CITRINE_API_KEY}`
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    const data = await res.json();
    if (data.errors) {
      console.error("[Citrine] registerIdTag GraphQL Errors:", JSON.stringify(data.errors));
      return { success: false, errors: data.errors };
    }

    console.log(`[Citrine] ID Tag registered successfully: ${idTag} with status: ${data.data.insert_Authorizations_one.status}`);
    return { success: true, data: data.data.insert_Authorizations_one };
  } catch (err) {
    console.error("[Citrine] registerIdTag failed:", err.message);
    return { success: false, error: err.message };
  }
}
