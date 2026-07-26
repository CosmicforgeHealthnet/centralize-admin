const { createAdvertisingExecutionApplication } = require("./application");
let application = null;
function getAdvertisingExecutionApplication() { if (!application) application = createAdvertisingExecutionApplication(); return application; }
function setAdvertisingExecutionApplication(value) { application = value; }
module.exports = { getAdvertisingExecutionApplication, setAdvertisingExecutionApplication };
