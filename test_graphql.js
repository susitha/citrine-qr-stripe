import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const HASURA_URL = "http://localhost:8090/v1/graphql";
const API_KEY = process.env.CITRINE_API_KEY;

async function testQuery() {
  const query = `
    query {
      MeterValues(limit: 50, order_by: {timestamp: desc}) {
        sampledValue
        timestamp
        transactionId
      }
    }
  `;

  try {
    const res = await fetch(HASURA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();
    const meterValues = data.data?.MeterValues || [];
    
    meterValues.forEach(mv => {
      const soc = mv.sampledValue.find(sv => sv.measurand === "SoC");
      if (soc) {
        console.log(`Found SoC: ${soc.value}% for Transaction: ${mv.transactionId} at ${mv.timestamp}`);
      }
    });

    if (!meterValues.some(mv => mv.sampledValue.some(sv => sv.measurand === "SoC"))) {
      console.log("No SoC found in recent 50 meter values.");
      // Print first sample to see what measurands we have
      if (meterValues.length > 0) {
        console.log("Available measurands in latest sample:", meterValues[0].sampledValue.map(sv => sv.measurand).join(", "));
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testQuery();
