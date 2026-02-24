import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const HASURA_URL = "http://localhost:8090/v1/graphql";
const API_KEY = process.env.CITRINE_API_KEY;

async function testQuery() {
  const query = `
    query {
      Transactions(limit: 5, order_by: {startTime: desc}) {
        id
        transactionId
        stationId
        isActive
        MeterValues(limit: 5, order_by: {timestamp: desc}) {
          sampledValue
          timestamp
        }
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
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testQuery();
