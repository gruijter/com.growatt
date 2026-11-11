Collega il tuo inverter Growatt a Homey e ottieni informazioni dettagliate sulla produzione di energia solare e sull'utilizzo della batteria.
Monitora la tua attuale produzione di energia, così come la tua generazione giornaliera, mensile, annuale e totale. Con l'app GroWatt per Homey, puoi utilizzare questi dati per ottimizzare il tuo consumo energetico, creare Flussi (Flows) e tenere traccia delle prestazioni del tuo sistema — tutto in un unico posto.

Connessione locale (Modbus TCP): l'inverter, la batteria e il contatore possono essere aggiunti anche senza il cloud Growatt, tramite un datalogger ShineWiLan-X2 nella rete locale. Scegli il dispositivo contrassegnato '(Modbus)'. Si aggiornano ogni 10 secondi. Assegna al datalogger un indirizzo IP fisso nel router. Altri datalogger non sono supportati. Non aggiungere lo stesso inverter sia tramite il cloud che tramite Modbus, altrimenti Homey Energy lo conta due volte.

Il controllo della batteria funziona meglio con un firmware dell'inverter che supporta VPP. Senza VPP la batteria si controlla solo in modo grossolano o per niente. Growatt può aggiornare il firmware da remoto.
