Anslut din Growatt-växelriktare till Homey och få detaljerade insikter om din solenergiproduktion och batterianvändning.
Övervaka din nuvarande uteffekt, samt din dagliga, månatliga, årliga och totala produktion. Med GroWatt-appen för Homey kan du använda dessa data för att optimera din energianvändning, skapa flöden och hålla koll på systemets prestanda – allt på ett ställe.

Lokal anslutning (Modbus TCP): växelriktaren, batteriet och elmätaren kan också läggas till utan Growatt-molnet, via en ShineWiLan-X2-datalogger i ditt lokala nätverk. Välj enheten märkt '(Modbus)'. De uppdateras var 10:e sekund. Ge dataloggern en fast IP-adress i routern. Andra donglar stöds inte. Lägg inte till samma växelriktare både via molnet och Modbus, annars räknar Homey Energy den dubbelt.

Batteristyrning fungerar bäst med växelriktarfirmware som stöder VPP. Utan VPP kan batteriet bara styras grovt eller inte alls. Growatt kan uppdatera firmwaren på distans.
