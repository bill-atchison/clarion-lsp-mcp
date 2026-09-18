  PROGRAM

  MAP
Greet PROCEDURE(STRING pName),STRING
  END

Counter LONG

  CODE
  Counter = 1
  MESSAGE(Greet('World'))

Greet PROCEDURE(STRING pName)
  CODE
  RETURN 'Hello ' & pName
