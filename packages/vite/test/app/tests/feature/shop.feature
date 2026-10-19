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

  Scenario: The visitor sees the shop loading until it answers
    Given the shop sells "Tea" and "Coffee"
    And the shop is slow to answer
    When the visitor opens the shop
    Then they see the shop loading
    When the shop answers
    Then they see "Tea" and "Coffee" under "Corner shop"
