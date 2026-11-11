# Growatt

Smart energy for a green future.

Connect your Growatt Inverter to Homey and get detailed insights into your solar energy production and battery usage.
Monitor your current power output, as well as your daily, monthly, yearly, and total generation. With the GroWatt app for Homey, you can use this data to optimize your energy usage, create Flows, and keep track of your system's performance — all in one place.

Local connection (Modbus TCP): the inverter, battery and grid meter can also be added without the Growatt cloud, through a ShineWiLan-X2 datalogger on your local network. Choose the device marked '(Modbus)'. These update every 10 seconds. Give the datalogger a fixed IP address in your router. Other dataloggers are not supported. Do not add the same inverter through both the cloud and Modbus, or Homey Energy counts it twice.

Battery control works best on inverter firmware with VPP support. Without it, the battery can only be controlled coarsely or not at all. Growatt can update the firmware remotely.
