# Disclaimer

Buddy is **experimental, open-source research software** for studying automated insulin
delivery (AID) algorithms. It is **not a medical device**, it is not cleared or approved by
any regulator (FDA, EU MDR or otherwise), and it is not intended to diagnose, treat, cure or
prevent any disease.

- Do not use Buddy to make treatment decisions.
- The demo pump and CGM are simulated. Buddy also contains **experimental** pump and CGM
  drivers (Dana, Medtrum, Dexcom, Libre, Nightscout); they are verified only against protocol
  simulators, not on hardware, and must never be used on or with a person. Closed loop stays
  off for a pump until its in-app hardware check is done and refuses mixed real and
  simulated devices.
- Simulation results compare algorithms against each other on a mathematical model. They
  do **not** predict how any algorithm will behave for a real person.

Anyone who builds, modifies or runs this software does so entirely at their own risk. The
authors and contributors accept no liability whatsoever.
