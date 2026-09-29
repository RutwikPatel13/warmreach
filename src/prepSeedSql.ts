import type { Difficulty, PrepQuestion, PrepSet } from "./prep";

// ── LeetCode "SQL 50" study plan ────────────────────────────────────────────
// https://leetcode.com/studyplan/top-sql-50/
//
// A study plan, not a company tag — which is why PrepSet carries a `kind`.
// There is no frequency ranking and no recency window here; the order is a
// curriculum and the grouping is by topic. `rank` is therefore just position
// in the plan, and the UI must not dress it up as a frequency signal.
//
// Sections and their sizes are transcribed from the plan page; every slug,
// title, difficulty, acceptance, tag list and statement was then resolved
// against LeetCode's public API, so nothing here is a guess. One slug does not
// follow from its title — "Classes With at Least 5 Students" is question 596
// at classes-with-at-least-5-students.

const SECTIONS = [
  "Select",
  "Basic Joins",
  "Basic Aggregate Functions",
  "Sorting and Grouping",
  "Advanced Select and Joins",
  "Subqueries",
  "Advanced String Functions / Regex / Clause",
];

/** [id, slug, title, difficulty, acceptance, section, statement, tags] */
type Row = [number, string, string, Difficulty, number, string, string, string[]];

const SQL50: Row[] = [
  [1757,"recyclable-and-low-fat-products","Recyclable and Low Fat Products","Easy",88.6,"Select","Table: Products product_id is the primary key (column with unique values) for this table. low_fats is an ENUM (category) of type ('Y', 'N') where 'Y' means this product is low fat and 'N' means it is not. recyclable is an ENUM (category) of types ('Y', 'N') where 'Y' means thi…",["Database"]],
  [584,"find-customer-referee","Find Customer Referee","Easy",73.3,"Select","Table: Customer In SQL, id is the primary key column for this table. Each row of this table indicates the id of a customer, their name, and the id of the customer who referred them. Find the names of the customer that are either: referred by any customer with id != 2 . not ref…",["Database"]],
  [595,"big-countries","Big Countries","Easy",68.7,"Select","Table: World name is the primary key (column with unique values) for this table. Each row of this table gives information about the name of a country, the continent to which it belongs, its area, the population, and its GDP value. A country is big if: it has an area of at leas…",["Database"]],
  [1148,"article-views-i","Article Views I","Easy",76.8,"Select","Table: Views There is no primary key (column with unique values) for this table, the table may have duplicate rows. Each row of this table indicates that some viewer viewed an article (written by some author) on some date. Note that equal author_id and viewer_id indicate the s…",["Database"]],
  [1683,"invalid-tweets","Invalid Tweets","Easy",85.2,"Select","Table: Tweets tweet_id is the primary key (column with unique values) for this table. content consists of alphanumeric characters, '!', or ' ' and no other special characters. This table contains all the tweets in a social media app. Write a solution to find the IDs of the inv…",["Database"]],
  [1378,"replace-employee-id-with-the-unique-identifier","Replace Employee ID With The Unique Identifier","Easy",83.8,"Basic Joins","Table: Employees id is the primary key (column with unique values) for this table. Each row of this table contains the id and the name of an employee in a company. Table: EmployeeUNI (id, unique_id) is the primary key (combination of columns with unique values) for this table.…",["Database"]],
  [1068,"product-sales-analysis-i","Product Sales Analysis I","Easy",86.1,"Basic Joins","Table: Sales (sale_id, year) is the primary key (combination of columns with unique values) of this table. product_id is a foreign key (reference column) to Product table. Each row of this table shows a sale on the product product_id in a certain year. Note that the price is p…",["Database"]],
  [1581,"customer-who-visited-but-did-not-make-any-transactions","Customer Who Visited but Did Not Make Any Transactions","Easy",68.3,"Basic Joins","Table: Visits visit_id is the column with unique values for this table. This table contains information about the customers who visited the mall. Table: Transactions transaction_id is column with unique values for this table. This table contains information about the transacti…",["Database"]],
  [197,"rising-temperature","Rising Temperature","Easy",51.9,"Basic Joins","Table: Weather id is the column with unique values for this table. There are no different rows with the same recordDate. This table contains information about the temperature on a certain day. Write a solution to find all dates' id with higher temperatures compared to its prev…",["Database"]],
  [1661,"average-time-of-process-per-machine","Average Time of Process per Machine","Easy",66.9,"Basic Joins","Table: Activity The table shows the user activities for a factory website. (machine_id, process_id, activity_type) is the primary key (combination of columns with unique values) of this table. machine_id is the ID of a machine. process_id is the ID of a process running on the …",["Database"]],
  [577,"employee-bonus","Employee Bonus","Easy",77.9,"Basic Joins","Table: Employee empId is the column with unique values for this table. Each row of this table indicates the name and the ID of an employee in addition to their salary and the id of their manager. Table: Bonus empId is the column of unique values for this table. empId is a fore…",["Database"]],
  [1280,"students-and-examinations","Students and Examinations","Easy",61.8,"Basic Joins","Table: Students student_id is the primary key (column with unique values) for this table. Each row of this table contains the ID and the name of one student in the school. Table: Subjects subject_name is the primary key (column with unique values) for this table. Each row of t…",["Database"]],
  [570,"managers-with-at-least-5-direct-reports","Managers with at Least 5 Direct Reports","Medium",49.4,"Basic Joins","Table: Employee id is the primary key (column with unique values) for this table. Each row of this table indicates the name of an employee, their department, and the id of their manager. If managerId is null, then the employee does not have a manager. No employee will be the m…",["Database"]],
  [1934,"confirmation-rate","Confirmation Rate","Medium",62.5,"Basic Joins","Table: Signups user_id is the column of unique values for this table. Each row contains information about the signup time for the user with ID user_id. Table: Confirmations (user_id, time_stamp) is the primary key (combination of columns with unique values) for this table. use…",["Database"]],
  [620,"not-boring-movies","Not Boring Movies","Easy",75.2,"Basic Aggregate Functions","Table: Cinema id is the primary key (column with unique values) for this table. Each row contains information about the name of a movie, its genre, and its rating. rating is a 2 decimal places float in the range [0, 10] Write a solution to report the movies with an odd-numbere…",["Database"]],
  [1251,"average-selling-price","Average Selling Price","Easy",37.7,"Basic Aggregate Functions","Table: Prices (product_id, start_date, end_date) is the primary key (combination of columns with unique values) for this table. Each row of this table indicates the price of the product_id in the period from start_date to end_date. For each product_id there will be no two over…",["Database"]],
  [1075,"project-employees-i","Project Employees I","Easy",67.2,"Basic Aggregate Functions","Table: Project (project_id, employee_id) is the primary key of this table. employee_id is a foreign key to Employee table. Each row of this table indicates that the employee with employee_id is working on the project with project_id. Table: Employee employee_id is the primary …",["Database"]],
  [1633,"percentage-of-users-attended-a-contest","Percentage of Users Attended a Contest","Easy",60.9,"Basic Aggregate Functions","Table: Users user_id is the primary key (column with unique values) for this table. Each row of this table contains the name and the id of a user. Table: Register (contest_id, user_id) is the primary key (combination of columns with unique values) for this table. Each row of t…",["Database"]],
  [1211,"queries-quality-and-percentage","Queries Quality and Percentage","Easy",54.4,"Basic Aggregate Functions","Table: Queries This table may have duplicate rows. This table contains information collected from some queries on a database. The position column has a value from 1 to 500 . The rating column has a value from 1 to 5 . Query with rating less than 3 is a poor query. We define qu…",["Database"]],
  [1193,"monthly-transactions-i","Monthly Transactions I","Medium",59.7,"Basic Aggregate Functions","Table: Transactions id is the primary key of this table. The table has information about incoming transactions. The state column is an enum of type [\"approved\", \"declined\"]. Write an SQL query to find for each month and country, the number of transactions and their total amoun…",["Database"]],
  [1174,"immediate-food-delivery-ii","Immediate Food Delivery II","Medium",56.7,"Basic Aggregate Functions","Table: Delivery delivery_id is the column of unique values of this table. The table holds information about food delivery to customers that make orders at some date and specify a preferred delivery date (on the same order date or after it). If the customer's preferred delivery…",["Database"]],
  [550,"game-play-analysis-iv","Game Play Analysis IV","Medium",42.1,"Basic Aggregate Functions","Table: Activity (player_id, event_date) is the primary key (combination of columns with unique values) of this table. This table shows the activity of players of some games. Each row is a record of a player who logged in and played a number of games (possibly 0) before logging…",["Database"]],
  [2356,"number-of-unique-subjects-taught-by-each-teacher","Number of Unique Subjects Taught by Each Teacher","Easy",89.3,"Sorting and Grouping","Table: Teacher (subject_id, dept_id) is the primary key (combinations of columns with unique values) of this table. Each row in this table indicates that the teacher with teacher_id teaches the subject subject_id in the department dept_id. Write a solution to calculate the num…",["Database"]],
  [1141,"user-activity-for-the-past-30-days-i","User Activity for the Past 30 Days I","Easy",51.4,"Sorting and Grouping","Table: Activity This table may have duplicate rows. The activity_type column is an ENUM (category) of type ('open_session', 'end_session', 'scroll_down', 'send_message'). The table shows the user activities for a social media website. Note that each session belongs to exactly …",["Database"]],
  [1070,"product-sales-analysis-iii","Product Sales Analysis III","Medium",46.4,"Sorting and Grouping","Table: Sales (sale_id, year) is the primary key (combination of columns with unique values) of this table. Each row records a sale of a product in a given year. A product may have multiple sales entries in the same year. Note that the per-unit price. Write a solution to find a…",["Database"]],
  [596,"classes-with-at-least-5-students","Classes With at Least 5 Students","Easy",64.6,"Sorting and Grouping","Table: Courses (student, class) is the primary key (combination of columns with unique values) for this table. Each row of this table indicates the name of a student and the class in which they are enrolled. Write a solution to find all the classes that have at least five stud…",["Database"]],
  [1729,"find-followers-count","Find Followers Count","Easy",69.6,"Sorting and Grouping","Table: Followers (user_id, follower_id) is the primary key (combination of columns with unique values) for this table. This table contains the IDs of a user and a follower in a social media app where the follower follows the user. Write a solution that will, for each user, ret…",["Database"]],
  [619,"biggest-single-number","Biggest Single Number","Easy",71.9,"Sorting and Grouping","Table: MyNumbers This table may contain duplicates (In other words, there is no primary key for this table in SQL). Each row of this table contains an integer. A single number is a number that appeared only once in the MyNumbers table. Find the largest single number . If there…",["Database"]],
  [1045,"customers-who-bought-all-products","Customers Who Bought All Products","Medium",64.4,"Sorting and Grouping","Table: Customer This table may contain duplicates rows. customer_id is not NULL . product_key is a foreign key (reference column) to Product table. Table: Product product_key is the primary key (column with unique values) for this table. Write a solution to report the customer…",["Database"]],
  [1731,"the-number-of-employees-which-report-to-each-employee","The Number of Employees Which Report to Each Employee","Easy",53.7,"Advanced Select and Joins","Table: Employees employee_id is the column with unique values for this table. This table contains information about the employees and the id of the manager they report to. Some employees do not report to anyone (reports_to is null). For this problem, we will consider a manager…",["Database"]],
  [1789,"primary-department-for-each-employee","Primary Department for Each Employee","Easy",75.1,"Advanced Select and Joins","Table: Employee (employee_id, department_id) is the primary key (combination of columns with unique values) for this table. employee_id is the id of the employee. department_id is the id of the department to which the employee belongs. primary_flag is an ENUM (category) of typ…",["Database"]],
  [610,"triangle-judgement","Triangle Judgement","Easy",75.1,"Advanced Select and Joins","Table: Triangle In SQL, (x, y, z) is the primary key column for this table. Each row of this table contains the lengths of three line segments. Report for every three line segments whether they can form a triangle. Return the result table in any order . The result format is in…",["Database"]],
  [180,"consecutive-numbers","Consecutive Numbers","Medium",49.1,"Advanced Select and Joins","Table: Logs In SQL, id is the primary key for this table. id is an autoincrement column starting from 1. Find all numbers that appear at least three times consecutively. Return the result table in any order . The result format is in the following example. Example 1: Input: Log…",["Database"]],
  [1164,"product-price-at-a-given-date","Product Price at a Given Date","Medium",58.3,"Advanced Select and Joins","Table: Products (product_id, change_date) is the primary key (combination of columns with unique values) of this table. Each row of this table indicates that the price of some product was changed to a new price at some date. Initially, all products have price 10. Write a solut…",["Database"]],
  [1204,"last-person-to-fit-in-the-bus","Last Person to Fit in the Bus","Medium",69.7,"Advanced Select and Joins","Table: Queue person_id column contains unique values. This table has the information about all people waiting for a bus. The person_id and turn columns will contain all numbers from 1 to n, where n is the number of rows in the table. turn determines the order of which the peop…",["Database"]],
  [1907,"count-salary-categories","Count Salary Categories","Medium",65.1,"Advanced Select and Joins","Table: Accounts account_id is the primary key (column with unique values) for this table. Each row contains information about the monthly income for one bank account. Write a solution to calculate the number of bank accounts for each salary category. The salary categories are:…",["Database"]],
  [1978,"employees-whose-manager-left-the-company","Employees Whose Manager Left the Company","Easy",48.9,"Subqueries","Table: Employees In SQL, employee_id is the primary key for this table. This table contains information about the employees, their salary, and the ID of their manager. Some employees do not have a manager (manager_id is null). Find the IDs of the employees whose salary is stri…",["Database"]],
  [626,"exchange-seats","Exchange Seats","Medium",74.7,"Subqueries","Table: Seat id is the primary key (unique value) column for this table. Each row of this table indicates the name and the ID of a student. The ID sequence always starts from 1 and increments continuously. Write a solution to swap the seat id of every two consecutive students. …",["Database"]],
  [1341,"movie-rating","Movie Rating","Medium",44.2,"Subqueries","Table: Movies movie_id is the primary key (column with unique values) for this table. title is the name of the movie. Each movie has a unique title. Table: Users user_id is the primary key (column with unique values) for this table. The column 'name' has unique values. Table: …",["Database"]],
  [1321,"restaurant-growth","Restaurant Growth","Medium",59.6,"Subqueries","Table: Customer In SQL,(customer_id, visited_on) is the primary key for this table. This table contains data about customer transactions in a restaurant. visited_on is the date on which the customer with ID (customer_id) has visited the restaurant. amount is the total paid by …",["Database"]],
  [602,"friend-requests-ii-who-has-the-most-friends","Friend Requests II: Who Has the Most Friends","Medium",63.4,"Subqueries","Table: RequestAccepted (requester_id, accepter_id) is the primary key (combination of columns with unique values) for this table. This table contains the ID of the user who sent the request, the ID of the user who received the request, and the date when the request was accepte…",["Database"]],
  [585,"investments-in-2016","Investments in 2016","Medium",51.6,"Subqueries","Table: Insurance pid is the primary key (column with unique values) for this table. Each row of this table contains information about one policy where: pid is the policyholder's policy ID. tiv_2015 is the total investment value in 2015 and tiv_2016 is the total investment valu…",["Database"]],
  [185,"department-top-three-salaries","Department Top Three Salaries","Hard",61.4,"Subqueries","Table: Employee id is the primary key (column with unique values) for this table. departmentId is a foreign key (reference column) of the ID from the Department table. Each row of this table indicates the ID, name, and salary of an employee. It also contains the ID of their de…",["Database"]],
  [1667,"fix-names-in-a-table","Fix Names in a Table","Easy",60.6,"Advanced String Functions / Regex / Clause","Table: Users user_id is the primary key (column with unique values) for this table. This table contains the ID and the name of the user. The name consists of only lowercase and uppercase characters. Write a solution to fix the names so that only the first character is uppercas…",["Database"]],
  [1527,"patients-with-a-condition","Patients With a Condition","Easy",39.2,"Advanced String Functions / Regex / Clause","Table: Patients patient_id is the primary key (column with unique values) for this table. 'conditions' contains 0 or more code separated by spaces. This table contains information of the patients in the hospital. Write a solution to find the patient_id, patient_name, and condi…",["Database"]],
  [196,"delete-duplicate-emails","Delete Duplicate Emails","Easy",66.6,"Advanced String Functions / Regex / Clause","Table: Person id is the primary key (column with unique values) for this table. Each row of this table contains an email. The emails will not contain uppercase letters. Write a solution to delete all duplicate emails, keeping only one unique email with the smallest id . For SQ…",["Database"]],
  [176,"second-highest-salary","Second Highest Salary","Medium",48.0,"Advanced String Functions / Regex / Clause","Table: Employee id is the primary key (column with unique values) for this table. Each row of this table contains information about the salary of an employee. Write a solution to find the second highest distinct salary from the Employee table. If there is no second highest sal…",["Database"]],
  [1484,"group-sold-products-by-the-date","Group Sold Products By The Date","Easy",78.2,"Advanced String Functions / Regex / Clause","Table Activities : There is no primary key (column with unique values) for this table. It may contain duplicates. Each row of this table contains the product name and the date it was sold in a market. Write a solution to find for each date the number of different products sold…",["Database"]],
  [1327,"list-the-products-ordered-in-a-period","List the Products Ordered in a Period","Easy",72.0,"Advanced String Functions / Regex / Clause","Table: Products product_id is the primary key (column with unique values) for this table. This table contains data about the company's products. Table: Orders This table may have duplicate rows. product_id is a foreign key (reference column) to the Products table. unit is the …",["Database"]],
  [1517,"find-users-with-valid-e-mails","Find Users With Valid E-Mails","Easy",35.4,"Advanced String Functions / Regex / Clause","Table: Users user_id is the primary key (column with unique values) for this table. This table contains information of the users signed up in a website. Some e-mails are invalid. Write a solution to find the users who have valid emails . A valid e-mail has a prefix name and a …",["Database"]],
];

export const SQL50_SET: PrepSet = {
  company: "top-sql-50",
  label: "SQL 50",
  kind: "studyplan",
  sections: SECTIONS,
  syncedAt: "2026-08-15",
  sources: [{ repo: "leetcode.com/studyplan/top-sql-50 (transcribed)", snapshot: "2026-08-15", windows: [] }],
  questions: SQL50.map(
    (r, i): PrepQuestion => ({
      id: r[0],
      slug: r[1],
      title: r[2],
      difficulty: r[3],
      acceptance: r[4],
      rank: i + 1, // position in the plan, not a frequency
      windows: [],
      lcSolved: false,
      tags: r[7],
      statement: r[6],
      section: r[5],
    }),
  ),
};

/** Plan totals as printed on the study-plan page, re-asserted at load. */
export function sqlSeedIntegrity(): string[] {
  const p: string[] = [];
  const qs = SQL50_SET.questions;
  if (qs.length !== 50) p.push(`SQL 50: ${qs.length} questions, expected 50`);
  for (const [d, n] of [["Easy", 32], ["Medium", 17], ["Hard", 1]] as const) {
    const got = qs.filter((q) => q.difficulty === d).length;
    if (got !== n) p.push(`SQL 50: ${d} is ${got}, expected ${n}`);
  }
  for (const [name, n] of [["Select", 5], ["Basic Joins", 9], ["Basic Aggregate Functions", 8],
    ["Sorting and Grouping", 7], ["Advanced Select and Joins", 7], ["Subqueries", 7],
    ["Advanced String Functions / Regex / Clause", 7]] as const) {
    const got = qs.filter((q) => q.section === name).length;
    if (got !== n) p.push(`SQL 50: section "${name}" has ${got}, expected ${n}`);
  }
  const unknown = qs.filter((q) => !SECTIONS.includes(q.section ?? ""));
  if (unknown.length) p.push(`SQL 50: ${unknown.length} question(s) in an unlisted section`);
  return p;
}
