# from govee.api.lan import power, brightness, color

# # Manually define your device's local IP
# DEVICE_IP_1 = "192.168.2.30"
# DEVICE_IP_2 = "192.168.2.26"

# # 1. Turn the device ON
# power.send_power(
#     device_ip=DEVICE_IP_1, 
#     on=True
# )

# # 2. Set brightness to 80%
# brightness.send_brightness(
#     device_ip=DEVICE_IP_1, 
#     percent=80
# )

# # 3. Set a specific color (e.g., Red)
# color.send_color(
#     device_ip=DEVICE_IP_1, 
#     rgb=(255, 0, 0)
# )

import base64
import json
import socket
import time


IP = "192.168.2.30"
PORT = 4003
PIXELS = 45
FPS = 20


def checksum(packet):
    value = 0
    for byte in packet:
        value ^= byte
    return value


def frame(colors):
    packet = [0xBB, 0x00, 0xFA, 0xB0, 0x00, len(colors)]
    for r, g, b in colors:
        packet.extend([r, g, b])
    packet.append(checksum(packet))
    payload = base64.b64encode(bytes(packet)).decode("ascii")
    return json.dumps({"msg": {"cmd": "razer", "data": {"pt": payload}}}).encode()


def control(enabled):
    packet = [0xBB, 0x00, 0x01, 0xB1, 0x01 if enabled else 0x00, 0x0A if enabled else 0x0B]
    payload = base64.b64encode(bytes(packet)).decode("ascii")
    return json.dumps({"msg": {"cmd": "razer", "data": {"pt": payload}}}).encode()


sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.sendto(control(True), (IP, PORT))

try:
    # for i in range(PIXELS * 4):
    #     colors = [(0, 0, 0)] * PIXELS
    #     colors[i % PIXELS] = (255, 0, 0)
    #     sock.sendto(frame(colors), (IP, PORT))
    #     time.sleep(1 / FPS)
    while True:
        for i in range(26,PIXELS):
            print(f"Lighting segment {i}")
            colors = [(0, 0, 0)] * PIXELS
            colors[i] = (255, 0, 0)
            sock.sendto(frame(colors), (IP, PORT))
            time.sleep(1)
finally:
    sock.sendto(frame([(0, 0, 0)] * PIXELS), (IP, PORT))
    sock.sendto(control(False), (IP, PORT))