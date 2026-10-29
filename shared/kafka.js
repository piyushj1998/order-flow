const { Kafka, Partitioners } = require('kafkajs');
const { randomUUID } = require('node:crypto');

const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092')
  .split(',').map((value) => value.trim()).filter(Boolean);

function createKafka(clientId) {
  return new Kafka({
    clientId,
    brokers,
    retry: { initialRetryTime: 500, retries: 8 },
  });
}

function createEventBus(clientId) {
  const kafka = createKafka(clientId);
  let producerPromise;

  async function getProducer() {
    if (!producerPromise) {
      producerPromise = (async () => {
        const producer = kafka.producer({
          createPartitioner: Partitioners.LegacyPartitioner,
          allowAutoTopicCreation: true,
        });
        await producer.connect();
        return producer;
      })().catch((error) => {
        producerPromise = undefined;
        throw error;
      });
    }
    return producerPromise;
  }

  async function publish(topic, key, payload) {
    const producer = await getProducer();
    const event = {
      eventId: payload.eventId || randomUUID(),
      occurredAt: payload.occurredAt || new Date().toISOString(),
      ...payload,
    };
    await producer.send({
      topic,
      messages: [{
        key: String(key),
        value: JSON.stringify(event),
        headers: { eventType: topic, eventId: event.eventId },
      }],
    });
    return event;
  }

  async function startConsumer({ groupId, topics, onEvent }) {
    const consumer = kafka.consumer({ groupId });
    while (true) {
      try {
        await consumer.connect();
        for (const topic of topics) {
          await consumer.subscribe({ topic, fromBeginning: false });
        }
        await consumer.run({
          eachMessage: async ({ topic, partition, message }) => {
            const raw = message.value ? message.value.toString() : '';
            try {
              const payload = JSON.parse(raw);
              await onEvent({ topic, partition, offset: message.offset, payload });
            } catch (error) {
              console.error(`[Kafka consumer ${groupId}] Failed to process ${topic}/${partition}/${message.offset}:`, error.message);
              // In production, route poison messages to a DLQ and add retry policy.
              throw error;
            }
          },
        });
        console.log(`[Kafka consumer ${groupId}] Listening to: ${topics.join(', ')}`);
        return consumer;
      } catch (error) {
        console.error(`[Kafka consumer ${groupId}] Could not start: ${error.message}. Retrying in 3 seconds...`);
        try { await consumer.disconnect(); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  return { kafka, publish, startConsumer };
}

module.exports = { createKafka, createEventBus, brokers };
