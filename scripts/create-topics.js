require('dotenv').config();
const { createKafka } = require('../shared/kafka');

async function main() {
  const kafka = createKafka('orderflow-topic-setup');
  const admin = kafka.admin();
  try {
    await admin.connect();
    const result = await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: 'orders.created', numPartitions: 3, replicationFactor: 1 },
        { topic: 'payments.succeeded', numPartitions: 3, replicationFactor: 1 },
        { topic: 'payments.failed', numPartitions: 3, replicationFactor: 1 }
      ],
    });
    console.log(result ? 'Kafka topics created.' : 'Kafka topics already existed.');
    console.log(await admin.listTopics());
  } finally {
    await admin.disconnect();
  }
}

main().catch((error) => {
  console.error('Could not create Kafka topics:', error.message);
  process.exitCode = 1;
});
