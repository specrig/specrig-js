Feature: The shop

  Scenario: The visitor sees what the shop sells, under the shop's name
    Given the shop sells "Tea" and "Coffee"
    When the visitor opens the shop
    Then they see "Tea" and "Coffee" under "Corner shop"

  Scenario: The visitor goes to the help pages
    Given the shop sells "Tea" and "Coffee"
    When the visitor opens the shop
    And they click "Help"
    Then they are sent to the help pages
