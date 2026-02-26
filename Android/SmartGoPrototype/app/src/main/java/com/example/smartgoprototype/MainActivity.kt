package com.example.smartgoprototype

import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.amplifyframework.core.Amplify
import com.example.smartgoprototype.ui.addroute.AddRouteRoute
import com.example.smartgoprototype.ui.dashboard.DashboardRoute
import com.example.smartgoprototype.ui.login.LoginRoute
import com.example.smartgoprototype.ui.register.RegisterRoute
import com.example.smartgoprototype.ui.theme.SmartGoPrototypeTheme
import com.example.smartgoprototype.ui.register.ConfirmSignUpRoute
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Single-activity entry point for the app.
 *
 * The app uses Jetpack Compose + Navigation Compose. Screens are represented as composable
 * destinations inside a single NavHost.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            SmartGoPrototypeTheme {
                val navController = rememberNavController()
                SmartGoAppNavHost(navController = navController)
            }
        }
    }
}

/**
 * Central navigation graph for the app.
 */
@Composable
fun SmartGoAppNavHost(
    navController: NavHostController
) {
    NavHost(
        navController = navController,
        startDestination = Routes.SPLASH
    ) {
        // Splash
        composable(Routes.SPLASH) {
            SplashRoute(navController)
        }

        // Login
        composable(Routes.LOGIN) {
            LoginRoute(
                onLoginSuccess = {
                    // Clear login from back stack
                    navController.navigate(Routes.DASHBOARD) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
                onNavigateToRegister = {
                    navController.navigate(Routes.REGISTER)
                }
            )
        }

        // Register
        composable(Routes.REGISTER) {
            RegisterRoute(
                onRegisterSuccess = { email ->
                    // After successful sign-up, go to confirmation screen
                    val encodedEmail = Uri.encode(email)
                    navController.navigate("${Routes.CONFIRM_SIGN_UP}/$encodedEmail") {
                        //remove REGISTER from back stack
                        popUpTo(Routes.REGISTER) { inclusive = true }
                    }
                },
                onNavigateToLogin = {
                    navController.popBackStack()
                }
            )
        }

        // Confirm sign-up
        composable(
            route = "${Routes.CONFIRM_SIGN_UP}/{email}",
            arguments = listOf(
                navArgument("email") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val email = backStackEntry.arguments?.getString("email").orEmpty()
            val decodedEmail = Uri.decode(email)

            ConfirmSignUpRoute(
                email = decodedEmail,
                onConfirmSuccess = {
                    // On Confirmation navigate to Dashboard
                    navController.navigate(Routes.DASHBOARD) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
                onBackToLogin = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                }
            )
        }

        // Dashboard
        composable(Routes.DASHBOARD) {
            DashboardRoute(
                navController = navController,
                onNavigateToAddRoute = { navController.navigate(Routes.ADD_ROUTE) }
            )
        }

        // AddRoute
        composable(Routes.ADD_ROUTE) {
            AddRouteRoute(
                onBack = { navController.popBackStack() },
                onSaved = { navController.popBackStack() } // return to dashboard
            )
        }
    }
}

/**
 * SplashRoute: checks existing auth session and routes to
 * Dashboard or Login accordingly.
 *
 * - Amplify's `fetchAuthSession` is callback-based. It is invoked once in `LaunchedEffect(Unit)`
 *   to avoid re-running on every recomposition.
 * - Navigation is dispatched onto the Main thread.
 */
@Composable
fun SplashRoute(
    navController: NavHostController
) {
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        Amplify.Auth.fetchAuthSession(
            { result ->
                scope.launch(Dispatchers.Main) {
                    val dest = if (result.isSignedIn) {
                        Routes.DASHBOARD
                    } else {
                        Routes.LOGIN
                    }

                    navController.navigate(dest) {
                        popUpTo(Routes.SPLASH) { inclusive = true }
                    }
                }
            },
            { error ->
                Log.e("SmartGoApp", "fetchAuthSession failed", error)
                scope.launch(Dispatchers.Main) {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.SPLASH) { inclusive = true }
                    }
                }
            }
        )
    }

    // Basic splash screen loading indicator
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        CircularProgressIndicator()
    }
}