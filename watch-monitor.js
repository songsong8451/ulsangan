(function (global) {
  "use strict";

  const HEART_RATE_SERVICE = 0x180d;
  const HEART_RATE_MEASUREMENT = 0x2a37;

  let device = null;
  let characteristic = null;
  let onHeartRate = null;
  let onStatus = null;
  let connecting = false;

  function isSupported() {
    return Boolean(
      global.isSecureContext &&
        global.navigator &&
        global.navigator.bluetooth &&
        typeof global.navigator.bluetooth.requestDevice === "function"
    );
  }

  function reportStatus(status, message) {
    if (typeof onStatus !== "function") return;
    try {
      onStatus({ status: status, message: message });
    } catch (_) {
      // A consumer callback must not interrupt Bluetooth event handling.
    }
  }

  function readHeartRate(event) {
    const value = event.target && event.target.value;
    if (!value || value.byteLength < 2) {
      reportStatus("error", "심박수 측정값을 읽을 수 없습니다.");
      return;
    }

    const flags = value.getUint8(0);
    if (flags & 0x01 && value.byteLength < 3) {
      reportStatus("error", "심박수 측정값을 읽을 수 없습니다.");
      return;
    }
    const heartRate = flags & 0x01 ? value.getUint16(1, true) : value.getUint8(1);
    if (typeof onHeartRate === "function") {
      try {
        onHeartRate(heartRate);
      } catch (_) {
        // A consumer callback must not interrupt Bluetooth event handling.
      }
    }
  }

  function clearConnection() {
    if (characteristic) {
      characteristic.removeEventListener("characteristicvaluechanged", readHeartRate);
    }
    if (device) {
      device.removeEventListener("gattserverdisconnected", handleDisconnection);
    }
    characteristic = null;
    device = null;
  }

  function handleDisconnection() {
    clearConnection();
    connecting = false;
    reportStatus("disconnected", "시계 연결이 끊어졌습니다. 다시 연결해 주세요.");
  }

  function friendlyError(error) {
    if (error && error.name === "NotFoundError") {
      return "기기 선택이 취소되었습니다. 연결할 심박수 기기를 선택해 주세요.";
    }
    if (!isSupported()) {
      return "이 브라우저에서는 안전한 연결(HTTPS)에서 Web Bluetooth를 사용할 수 없습니다.";
    }
    if (error && error.name === "SecurityError") {
      return "브라우저 보안 설정으로 Bluetooth에 연결할 수 없습니다. HTTPS 페이지에서 다시 시도해 주세요.";
    }
    if (error && error.name === "NetworkError") {
      return "기기에 연결하지 못했습니다. 기기가 가까이 있고 켜져 있는지 확인해 주세요.";
    }
    return "Bluetooth 기기에 연결할 수 없습니다. 심박수 측정을 지원하는 기기인지 확인한 뒤 다시 시도해 주세요.";
  }

  async function connect(options) {
    options = options || {};
    onHeartRate = typeof options.onHeartRate === "function" ? options.onHeartRate : null;
    onStatus = typeof options.onStatus === "function" ? options.onStatus : null;

    if (!isSupported()) {
      const error = new Error("이 브라우저에서는 안전한 연결(HTTPS)에서 Web Bluetooth를 사용할 수 없습니다.");
      reportStatus("error", error.message);
      throw error;
    }
    if (connecting) {
      throw new Error("이미 기기 연결을 진행하고 있습니다.");
    }
    if (device && device.gatt && device.gatt.connected) {
      reportStatus("connected", "심박수 기기에 이미 연결되어 있습니다.");
      return device;
    }

    connecting = true;
    reportStatus("connecting", "심박수 기기를 선택해 주세요.");

    try {
      device = await global.navigator.bluetooth.requestDevice({
        filters: [{ services: [HEART_RATE_SERVICE] }],
      });
      device.addEventListener("gattserverdisconnected", handleDisconnection);

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(HEART_RATE_SERVICE);
      characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT);
      characteristic.addEventListener("characteristicvaluechanged", readHeartRate);
      await characteristic.startNotifications();

      connecting = false;
      reportStatus("connected", "심박수 기기에 연결되었습니다.");
      return device;
    } catch (error) {
      const message = friendlyError(error);
      const wasCancelled = error && error.name === "NotFoundError";
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      clearConnection();
      connecting = false;
      reportStatus(wasCancelled ? "cancelled" : "error", message);
      throw new Error(message);
    }
  }

  function disconnect() {
    const currentDevice = device;
    clearConnection();
    connecting = false;
    if (currentDevice && currentDevice.gatt && currentDevice.gatt.connected) {
      currentDevice.gatt.disconnect();
    }
    reportStatus("disconnected", "시계 연결을 해제했습니다.");
  }

  function isConnected() {
    return Boolean(device && device.gatt && device.gatt.connected && characteristic);
  }

  global.ShiftFitWatch = {
    isSupported: isSupported,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
  };
})(window);
