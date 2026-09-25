/**
 * Local simulation test script.
 * Simulates Telegram webhook payloads to test logic end-to-end.
 */

async function runLocalSimulation() {
  console.log("=================================================");
  console.log("🧪 Simulating Telegram Life-Log Webhook Locally");
  console.log("=================================================\n");

  const localWebhookUrl = "http://localhost:3000/api/webhook";

  // Simulation 1: User sends /start
  console.log("1️⃣ Simulating command: /start");
  const startPayload = {
    message: {
      message_id: 1,
      chat: { id: 123456789 },
      text: "/start",
    },
  };
  console.log("Payload:", JSON.stringify(startPayload));

  // Simulation 2: User taps [+500ml Water] button
  console.log("\n2️⃣ Simulating button click: [+500ml Water]");
  const waterPayload = {
    callback_query: {
      id: "cb_water_001",
      data: "water_add:500",
      message: {
        message_id: 2,
        chat: { id: 123456789 },
      },
    },
  };
  console.log("Payload:", JSON.stringify(waterPayload));

  // Simulation 3: User says "Starting physics study now"
  console.log("\n3️⃣ Simulating natural text: 'Starting physics study now'");
  const timerStartPayload = {
    message: {
      message_id: 3,
      chat: { id: 123456789 },
      text: "Starting physics study now",
    },
  };
  console.log("Payload:", JSON.stringify(timerStartPayload));

  // Simulation 4: User sends diary entry
  console.log("\n4️⃣ Simulating diary entry: 'Worked on Mayapur 3D game with Vishnu for 3 hours...'");
  const diaryPayload = {
    message: {
      message_id: 4,
      chat: { id: 123456789 },
      text: "Today I worked on the Mayapur 3D game for 3 hours. Fixed mobile performance with Three.js. Met Vishnu in the evening to discuss textures.",
    },
  };
  console.log("Payload:", JSON.stringify(diaryPayload));

  console.log("\n✅ Simulation payloads generated cleanly!");
  console.log("When you start your server with 'npm run dev', you can POST these payloads to http://localhost:3000/api/webhook");
}

runLocalSimulation();
