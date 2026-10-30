async function closeServer(server) {
  if (!server || typeof server.close !== "function") return;
  if (server.listening === false) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

module.exports = { closeServer };
