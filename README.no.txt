Koble din Growatt-omformer til Homey og få detaljert innsikt i din solenergiproduksjon og batteribruk.
Overvåk din nåværende strømproduksjon, samt din daglige, månedlige, årlige og totale generering. Med GroWatt-appen for Homey kan du bruke disse dataene til å optimalisere energiforbruket ditt, lage Flows og holde oversikt over systemets ytelse – alt på ett sted.

Lokal tilkobling (Modbus TCP): omformeren, batteriet og strømmåleren kan også legges til uten Growatt-skyen, via en ShineWiLan-X2-datalogger på ditt lokale nettverk. Velg enheten merket '(Modbus)'. Disse oppdateres hvert 10. sekund. Gi dataloggeren en fast IP-adresse i ruteren. Andre dataloggere støttes ikke. Ikke legg til samme omformer både via skyen og Modbus, ellers teller Homey Energy den dobbelt.

Batteristyring fungerer best med vekselretterfirmware som støtter VPP. Uten VPP kan batteriet bare styres grovt eller ikke i det hele tatt. Growatt kan oppdatere firmwaren eksternt.
